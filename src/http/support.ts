import {
  type ArgumentsHost,
  type CanActivate,
  Catch,
  createParamDecorator,
  type ExceptionFilter,
  type ExecutionContext,
  HttpException,
  Injectable,
} from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { ConflictError, InvalidRequestError, NotFoundError } from '../application/errors';
import { UnitOfWork } from '../application/ports';
import { DomainError } from '../domain/errors';
import { newId } from '../domain/ids';
import { log } from '../infrastructure/observability/logger';

/** Toda requisição ganha um correlationId: o do cabeçalho x-correlation-id, ou um novo. Ele volta na resposta. */
export function correlationMiddleware(req: Request, res: Response, next: NextFunction): void {
  const recebido = req.header('x-correlation-id');
  const id = recebido && recebido.length <= 128 ? recebido : newId();
  (req as Request & { correlationId: string }).correlationId = id;
  res.setHeader('x-correlation-id', id);
  next();
}

export const CorrelationId = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): string => ctx.switchToHttp().getRequest<Request & { correlationId: string }>().correlationId,
);

/**
 * Ponto de extensão da autenticação (seção 2 do desafio): hoje deixa passar. O desenho previsto está no
 * ARCHITECTURE.md: validar um token OIDC de client credentials do IdP e casar o `providerId` do token com o do payload.
 */
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}

/**
 * Um status por situação, igual em todos os endpoints, para o provedor decidir sem ler a mensagem:
 * 400 payload inválido · 404 não encontrado · 409 conflito (idempotência, wallet duplicada) ·
 * 503 falha transitória de infraestrutura (reenviar depois) · 500 erro inesperado.
 * Rejeição por regra de negócio (422) e aceite pendente (202) são respostas normais do controller.
 */
@Catch()
@Injectable()
export class ErrorFilter implements ExceptionFilter {
  constructor(private readonly uow: UnitOfWork) {}

  catch(erro: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const req = host.switchToHttp().getRequest<Request & { correlationId?: string }>();
    const responder = (status: number, code: string, message: string, details?: string[]) =>
      res.status(status).json({ error: { code, message, ...(details?.length ? { details } : {}) } });

    if (erro instanceof InvalidRequestError) return void responder(400, 'INVALID_PAYLOAD', erro.message, erro.details);
    if (erro instanceof DomainError) return void responder(400, erro.code, erro.message);
    if (erro instanceof NotFoundError) return void responder(404, 'NOT_FOUND', erro.message);
    if (erro instanceof ConflictError) return void responder(409, erro.code, erro.message);
    if (erro instanceof HttpException) {
      const status = erro.getStatus();
      return void responder(status, status === 400 ? 'INVALID_PAYLOAD' : status === 404 ? 'NOT_FOUND' : 'HTTP_ERROR', erro.message);
    }
    if (this.uow.isTransient(erro)) {
      log.warn('falha transitória na requisição', { correlationId: req.correlationId, error: String((erro as Error).message) });
      res.setHeader('Retry-After', '1');
      return void responder(503, 'TEMPORARILY_UNAVAILABLE', 'infraestrutura indisponível no momento; reenvie a mesma requisição');
    }
    log.error('erro inesperado', { correlationId: req.correlationId, error: String((erro as Error)?.stack ?? erro) });
    responder(500, 'INTERNAL_ERROR', 'erro inesperado');
  }
}
