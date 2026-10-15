/**
 * A business rule said no. Domain code throws this instead of a bare Error so
 * the HTTP layer can answer 400/409 with the message, rather than a 500.
 */
export class RuleError extends Error {
  status: number;
  constructor(message: string, status = 409) {
    super(message);
    this.name = "RuleError";
    this.status = status;
  }
}
