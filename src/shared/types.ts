export type ServiceStatus = 'ok' | 'degraded';

export type DatabaseStatus = 'ok' | 'error';

export interface HealthResponse {
  status: ServiceStatus;
  service: 'luowang';
  version: string;
  database: DatabaseStatus;
  timestamp: string;
}

export interface ErrorResponse {
  error: {
    code: string;
    message: string;
    requestId: string;
  };
}
