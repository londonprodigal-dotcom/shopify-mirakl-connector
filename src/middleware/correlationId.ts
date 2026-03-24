import { AsyncLocalStorage } from 'async_hooks';
import { Request, Response, NextFunction } from 'express';
import * as crypto from 'crypto';

interface CorrelationContext {
  correlationId: string;
}

export const correlationStore = new AsyncLocalStorage<CorrelationContext>();

export function getCorrelationId(): string {
  return correlationStore.getStore()?.correlationId ?? 'no-context';
}

export function correlationMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const correlationId = (req.headers['x-correlation-id'] as string) ?? crypto.randomUUID();
  correlationStore.run({ correlationId }, () => next());
}
