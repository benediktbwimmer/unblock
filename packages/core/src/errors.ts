export class NotJiraError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "NotJiraError";
    this.code = code;
    this.details = details;
  }
}

export function notFound(entity: string, id: string): never {
  throw new NotJiraError("not_found", `${entity} not found: ${id}`, { entity, id });
}

export function conflict(message: string, details?: unknown): never {
  throw new NotJiraError("conflict", message, details);
}

export function validation(message: string, details?: unknown): never {
  throw new NotJiraError("validation", message, details);
}

export function invariant(message: string, details?: unknown): never {
  throw new NotJiraError("invariant", message, details);
}
