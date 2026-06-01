export type ServiceErrorFields = Record<string, string | number | boolean>;

export type ServiceError = Error & {
  code: string;
  fields: ServiceErrorFields;
};

export function serviceError(code: string, message: string, fields: ServiceErrorFields = {}): ServiceError {
  const error = new Error(message) as ServiceError;
  error.code = code;
  error.fields = fields;
  return error;
}
