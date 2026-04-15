import { HookEvent, HookContext, HookDefinition } from "../types/index.js";

export class HookManager {
  private hooks: Map<HookEvent, HookDefinition[]> = new Map();
  private sessionId: string;

  constructor(sessionId?: string) {
    this.sessionId = sessionId || `session-${Date.now()}`;
  }

  register(hook: HookDefinition): void {
    const events = Array.isArray(hook.event) ? hook.event : [hook.event];
    for (const event of events) {
      const existing = this.hooks.get(event) || [];
      existing.push(hook);
      existing.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
      this.hooks.set(event, existing);
    }
  }

  unregister(name: string): void {
    for (const [event, hooks] of this.hooks) {
      this.hooks.set(
        event,
        hooks.filter((h) => h.name !== name),
      );
    }
  }

  async emit(
    event: HookEvent,
    contextData: Partial<HookContext>,
  ): Promise<{
    aborted: boolean;
    modifiedArgs?: Record<string, unknown>;
  }> {
    const hooks = this.hooks.get(event) || [];
    let aborted = false;
    let modifiedArgs: Record<string, unknown> | undefined;

    const context: HookContext = {
      event,
      timestamp: Date.now(),
      sessionId: this.sessionId,
      abort: () => {
        aborted = true;
      },
      modifyArgs: (args) => {
        modifiedArgs = args;
      },
      ...contextData,
    };

    for (const hook of hooks) {
      if (hook.enabled === false) continue;
      try {
        await hook.handler(context);
        if (aborted) break;
      } catch (error) {
        console.error(`Hook "${hook.name}" failed:`, error);
        // Hook errors don't stop agent execution
      }
    }

    return { aborted, modifiedArgs };
  }

  list(): { event: HookEvent; hooks: HookDefinition[] }[] {
    const result: { event: HookEvent; hooks: HookDefinition[] }[] = [];
    for (const [event, hooks] of this.hooks) {
      result.push({ event, hooks });
    }
    return result;
  }

  getHookCount(): number {
    let count = 0;
    for (const hooks of this.hooks.values()) {
      count += hooks.length;
    }
    return count;
  }
}
