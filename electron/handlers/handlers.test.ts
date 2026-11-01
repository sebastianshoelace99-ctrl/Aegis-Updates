import { describe, expect, it } from "vitest";
import { contract } from "../../shared/contract";
import { handlers } from "./index";

/**
 * The cheapest high-value test in the project (docs/02 section 10). It fails the moment
 * someone adds a channel to `contract` and forgets the handler - the class of bug that
 * otherwise ships as a silently-rejected promise.
 */
describe("bridge contract", () => {
  it("registers a handler for every channel, and no others", () => {
    expect(Object.keys(handlers).sort()).toEqual(Object.keys(contract).sort());
  });
});
