import type { ErrorResponse } from '../shared/types.js';

export class AppError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function toErrorResponse(code: string, message: string, requestId: string): ErrorResponse {
  return {
    error: {
      code,
      message,
      requestId,
    },
  };
}
