import { describe, test, expect, beforeEach } from "bun:test";
import { CircuitBreaker } from "../src/providers/CircuitBreaker.js";

describe("CircuitBreaker", () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeSeconds: 1 });
  });

  test("initially closed", () => {
    expect(breaker.isOpen()).toBe(false);
  });

  test("records failures, stays closed below threshold", () => {
    breaker.recordFailure();
    expect(breaker.isOpen()).toBe(false);

    breaker.recordFailure();
    expect(breaker.isOpen()).toBe(false);
  });

  test("opens after reaching failure threshold", () => {
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.isOpen()).toBe(true);
  });

  test("opened breaker returns isOpen=true", () => {
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    const state = breaker.getState();
    expect(state.isOpen).toBe(true);
  });

  test("half-open: after reset time passes, isOpen returns false (allows retry)", async () => {
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.isOpen()).toBe(true);

    // Wait for reset time to pass (1 second)
    await new Promise((resolve) => setTimeout(resolve, 1100));

    expect(breaker.isOpen()).toBe(false);
  });

  test("recordSuccess resets to closed state", () => {
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.isOpen()).toBe(true);

    breaker.recordSuccess();
    expect(breaker.isOpen()).toBe(false);
    const state = breaker.getState();
    expect(state.failureCount).toBe(0);
  });

  test("reset() method works", () => {
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.isOpen()).toBe(true);

    breaker.reset();
    expect(breaker.isOpen()).toBe(false);
    const state = breaker.getState();
    expect(state.failureCount).toBe(0);
    expect(state.isOpen).toBe(false);
  });

  test("getState() returns correct copy", () => {
    breaker.recordFailure();
    const state1 = breaker.getState();
    const state2 = breaker.getState();

    expect(state1).not.toBe(state2); // Different objects
    expect(state1).toEqual(state2); // Same values
    expect(state1.failureCount).toBe(1);
  });
});
