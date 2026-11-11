import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageBatchCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { config } from '../../config';
import type { OutboxMessage } from '../../domain/messaging';

interface Filas {
  wager: string;
  dlq: string;
  events: string;
}

/** Acesso às três filas FIFO: entrada das transações, DLQ dela e saída dos eventos de integração. */
export class SqsGateway {
  readonly client = new SQSClient({
    endpoint: config.sqs.endpoint,
    region: config.sqs.region,
    credentials: { accessKeyId: config.sqs.accessKeyId, secretAccessKey: config.sqs.secretAccessKey },
    // as URLs do LocalStack apontam para um host próprio; as chamadas vão sempre para o endpoint configurado
    useQueueUrlAsEndpoint: false,
  });
  private filas?: Promise<Filas>;

  /** Resolve as URLs na primeira chamada. Se a SQS estiver fora, a próxima chamada tenta de novo. */
  queues(): Promise<Filas> {
    this.filas ??= (config.sqs.createQueues ? this.criarFilas() : this.buscarFilas()).catch(e => {
      this.filas = undefined;
      throw e;
    });
    return this.filas;
  }

  private async criarFilas(): Promise<Filas> {
    const fifo = { FifoQueue: 'true', ContentBasedDeduplication: 'true' };
    const dlq = (await this.client.send(new CreateQueueCommand({ QueueName: config.sqs.deadLetterQueue, Attributes: fifo }))).QueueUrl!;
    const arn = (await this.client.send(new GetQueueAttributesCommand({ QueueUrl: dlq, AttributeNames: ['QueueArn'] }))).Attributes!
      .QueueArn!;
    const wager = (
      await this.client.send(
        new CreateQueueCommand({
          QueueName: config.sqs.wagerQueue,
          Attributes: {
            ...fifo,
            VisibilityTimeout: String(config.sqs.visibilityTimeoutS),
            // depois de maxReceiveCount recebimentos sem ack, a própria SQS move a mensagem para a DLQ
            RedrivePolicy: JSON.stringify({ deadLetterTargetArn: arn, maxReceiveCount: String(config.sqs.maxReceiveCount) }),
          },
        }),
      )
    ).QueueUrl!;
    const events = (
      await this.client.send(new CreateQueueCommand({ QueueName: config.sqs.eventsQueue, Attributes: { FifoQueue: 'true' } }))
    ).QueueUrl!;
    return { wager, dlq, events };
  }

  private async buscarFilas(): Promise<Filas> {
    const url = async (QueueName: string) => (await this.client.send(new GetQueueUrlCommand({ QueueName }))).QueueUrl!;
    return {
      wager: await url(config.sqs.wagerQueue),
      dlq: await url(config.sqs.deadLetterQueue),
      events: await url(config.sqs.eventsQueue),
    };
  }

  async receive(signal: AbortSignal): Promise<Message[]> {
    const { wager } = await this.queues();
    const r = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: wager,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: config.sqs.waitTimeS,
        VisibilityTimeout: config.sqs.visibilityTimeoutS,
        MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
      }),
      { abortSignal: signal },
    );
    return r.Messages ?? [];
  }

  async delete(m: Message): Promise<void> {
    const { wager } = await this.queues();
    await this.client.send(new DeleteMessageCommand({ QueueUrl: wager, ReceiptHandle: m.ReceiptHandle }));
  }

  async changeVisibility(m: Message, seconds: number): Promise<void> {
    const { wager } = await this.queues();
    await this.client.send(
      new ChangeMessageVisibilityCommand({ QueueUrl: wager, ReceiptHandle: m.ReceiptHandle, VisibilityTimeout: seconds }),
    );
  }

  /** Erro permanente: copia para a DLQ com o motivo e só então apaga da fila (se a cópia falhar, a mensagem volta). */
  async moveToDeadLetter(m: Message, reason: string, detail: string): Promise<void> {
    const { dlq } = await this.queues();
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: dlq,
        MessageBody: m.Body ?? '',
        MessageGroupId: m.Attributes?.MessageGroupId ?? 'dead-letter',
        MessageDeduplicationId: m.MessageId,
        MessageAttributes: {
          reason: { DataType: 'String', StringValue: reason },
          detail: { DataType: 'String', StringValue: detail.slice(0, 500) || '-' },
        },
      }),
    );
    await this.delete(m);
  }

  /** Publica até 10 eventos; devolve os ids que a SQS aceitou. A deduplicação usa o eventId. */
  async publishEvents(mensagens: OutboxMessage[]): Promise<Set<string>> {
    const { events } = await this.queues();
    const r = await this.client.send(
      new SendMessageBatchCommand({
        QueueUrl: events,
        Entries: mensagens.map((m, i) => ({
          Id: String(i),
          MessageBody: JSON.stringify(m.payload),
          MessageGroupId: m.aggregateId,
          MessageDeduplicationId: m.id,
          MessageAttributes: { eventType: { DataType: 'String', StringValue: m.eventType } },
        })),
      }),
    );
    return new Set((r.Successful ?? []).map(s => mensagens[Number(s.Id)]!.id));
  }

  async ping(): Promise<boolean> {
    try {
      const { wager } = await this.queues();
      await this.client.send(new GetQueueAttributesCommand({ QueueUrl: wager, AttributeNames: ['QueueArn'] }));
      return true;
    } catch {
      return false;
    }
  }
}
