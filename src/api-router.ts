export type ApiRequestContext = Record<string, never>;
export type ApiHandler = (context: ApiRequestContext, ...args: unknown[]) => unknown;

class ApiRouter {
  private readonly handlers = new Map<string, ApiHandler>();

  handle<TArgs extends unknown[], TResult>(
    channel: string,
    handler: (context: ApiRequestContext, ...args: TArgs) => TResult,
  ): void {
    if (this.handlers.has(channel)) {
      throw new Error(`Handler already registered for ${channel}`);
    }
    this.handlers.set(channel, handler as ApiHandler);
  }

  async invoke(channel: string, args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (!handler) {
      throw new Error(`Unknown API channel: ${channel}`);
    }
    return handler({}, ...args);
  }
}

export const apiRouter = new ApiRouter();
