import { CircuitBreakerState } from "../types/index.js";

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  resetTimeSeconds?: number;
}

export class CircuitBreaker {
  private state: CircuitBreakerState;
  private failureThreshold: number;
  private resetTimeMs: number;

  constructor(options?: CircuitBreakerOptions) {
    this.failureThreshold = options?.failureThreshold ?? 3;
    this.resetTimeMs = (options?.resetTimeSeconds ?? 60) * 1000;
    this.state = {
      isOpen: false,
      failureCount: 0,
      lastFailureTime: 0,
      nextAttemptTime: 0,
    };
  }

  isOpen(): boolean {
    if (!this.state.isOpen) return false;
    // Half-open: if reset time has passed, allow one attempt
    if (Date.now() >= this.state.nextAttemptTime) {
      return false;
    }
    return true;
  }

  recordSuccess(): void {
    this.state = {
      isOpen: false,
      failureCount: 0,
      lastFailureTime: 0,
      nextAttemptTime: 0,
    };
  }

  recordFailure(): void {
    this.state.failureCount++;
    this.state.lastFailureTime = Date.now();
    if (this.state.failureCount >= this.failureThreshold) {
      this.state.isOpen = true;
      this.state.nextAttemptTime = Date.now() + this.resetTimeMs;
    }
  }

  getState(): CircuitBreakerState {
    return { ...this.state };
  }

  reset(): void {
    this.state = {
      isOpen: false,
      failureCount: 0,
      lastFailureTime: 0,
      nextAttemptTime: 0,
    };
  }
}
