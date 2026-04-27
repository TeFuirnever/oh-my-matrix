import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { isStructuredError, makeError, OMM_ERROR_CODES, } from "./omm-error-codes.js";
describe("omm-error-codes", () => {
    it("exposes all expected codes with OMM_E_ prefix", () => {
        const expected = [
            "KEY_MISSING",
            "KEY_INVALID",
            "VALUE_MISSING",
            "VALUE_INVALID",
            "STATE_INVALID",
            "WORKFLOW_CONFLICT",
            "IO_FAILED",
            "LOCK_TIMEOUT",
            "VERSION_MISMATCH",
            "INTERNAL",
        ];
        for (const k of expected) {
            assert.ok(k in OMM_ERROR_CODES, `missing key ${k}`);
            assert.match(OMM_ERROR_CODES[k], /^OMM_E_/, `code for ${k} must start with OMM_E_`);
        }
    });
    it("makeError builds a 2-field error when no hint passed", () => {
        const err = makeError(OMM_ERROR_CODES.KEY_MISSING, "key required");
        assert.equal(err.code, "OMM_E_KEY_MISSING");
        assert.equal(err.message, "key required");
        assert.equal(err.hint, undefined);
        assert.equal(Object.keys(err).length, 2);
    });
    it("makeError includes hint when provided", () => {
        const err = makeError(OMM_ERROR_CODES.LOCK_TIMEOUT, "lock acquisition timed out", "retry once with backoff");
        assert.equal(err.hint, "retry once with backoff");
        assert.equal(Object.keys(err).length, 3);
    });
    it("isStructuredError accepts well-formed objects", () => {
        const err = {
            code: OMM_ERROR_CODES.IO_FAILED,
            message: "disk full",
        };
        assert.ok(isStructuredError(err));
        assert.ok(isStructuredError({ ...err, hint: "free space" }));
    });
    it("isStructuredError rejects malformed values", () => {
        assert.ok(!isStructuredError(null));
        assert.ok(!isStructuredError(undefined));
        assert.ok(!isStructuredError("OMM_E_FOO"));
        assert.ok(!isStructuredError({ message: "no code" }));
        assert.ok(!isStructuredError({ code: "FOO_BAR", message: "wrong prefix" }));
        assert.ok(!isStructuredError({ code: "OMM_E_X" }), "must require message field");
    });
});
//# sourceMappingURL=omm-error-codes.test.js.map