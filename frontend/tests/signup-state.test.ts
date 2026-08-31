import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shouldOpenSignupGuide, signupNotice } from "../src/signup-state";

describe("signup return state", () => {
  it("reopens the guide with actionable OAuth failure copy", () => {
    assert.equal(shouldOpenSignupGuide("?oauth=invalid_state"), true);
    assert.match(signupNotice("?oauth=invalid_state") ?? "", /expired or was opened twice/);
    assert.match(signupNotice("?oauth=access_denied") ?? "", /Nothing was shared/);
    assert.match(signupNotice("?oauth=provider_failure") ?? "", /did not finish/);
  });

  it("opens for an app handoff and confirms a completed reset", () => {
    assert.equal(shouldOpenSignupGuide("?connect=1"), true);
    assert.equal(signupNotice("?connect=1"), null);
    assert.equal(shouldOpenSignupGuide("?setup=restarted"), true);
    assert.match(signupNotice("?setup=restarted") ?? "", /previous connection was cleared/);
  });
});
