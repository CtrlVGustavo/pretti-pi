import assert from "node:assert/strict";
import { test } from "node:test";
import { CredentialResolutionError, hasCredentialSource, resolveCredential } from "../../extensions/openai-web-search/credential-source.ts";

const fake = value => async () => ({ stdout: value });
const options = (configuredValue, environmentValue) => ({ provider: "Synthetic", configuredValue, environmentValue });

test("literal and legacy environment credentials preserve precedence", async () => {
	assert.equal(await resolveCredential(options("literal-value", "environment-value")), "environment-value");
	assert.equal(await resolveCredential(options("literal-value", undefined)), "literal-value");
	assert.equal(await resolveCredential(options(undefined, undefined)), null);
});

test("explicit environment sources use only the named variable", async () => {
	assert.equal(await resolveCredential({
		...options("${SCOPED_KEY}", "stale"),
		environment: { SCOPED_KEY: "scoped-value" },
	}), "scoped-value");
	await assert.rejects(
		resolveCredential({ ...options("$SCOPED_KEY", "stale"), environment: {} }),
		error => error instanceof CredentialResolutionError && error.category === "environment-empty",
	);
});

test("command sources are lazy, isolated, and rotate", async () => {
	let calls = 0;
	const credentialOptions = {
		...options("!/trusted/read openai", "stale"),
		environment: {
			HOME: "/home/test",
			PATH: "/usr/bin:/bin",
			OPENAI_API_KEY: "must-not-reach-command",
			OP_SESSION_test: "session",
			NODE_OPTIONS: "--require=untrusted.js",
		},
		runCommand: async (command, runOptions) => {
			calls += 1;
			assert.equal(command, "/trusted/read openai");
			assert.deepEqual(runOptions.environment, {
				HOME: "/home/test",
				PATH: "/usr/bin:/bin",
				OP_SESSION_test: "session",
			});
			return { stdout: `value-${calls}\n` };
		},
	};
	assert.equal(hasCredentialSource(credentialOptions), true);
	assert.equal(calls, 0);
	assert.equal(await resolveCredential(credentialOptions), "value-1");
	assert.equal(await resolveCredential(credentialOptions), "value-2");
});

test("command output is one non-empty bounded value", async () => {
	for (const [stdout, category] of [
		["", "command-empty"],
		["one\ntwo\n", "command-invalid-output"],
		["x".repeat(16_385), "command-output-too-large"],
	]) {
		await assert.rejects(
			resolveCredential({ ...options("!ignored", undefined), runCommand: fake(stdout) }),
			error => error instanceof CredentialResolutionError && error.category === category,
		);
	}
});

test("credential command failures do not expose command text or stderr", async () => {
	const secret = "SECRET_MUST_NOT_ESCAPE";
	await assert.rejects(
		resolveCredential({
			...options("!/trusted/read openai", undefined),
			runCommand: async () => { throw Object.assign(new Error(secret), { stderr: secret }); },
		}),
		error => {
			assert.equal(error instanceof CredentialResolutionError, true);
			assert.equal(error.message.includes(secret), false);
			assert.equal(error.message.includes("/trusted/read"), false);
			return true;
		},
	);
});

test("escaped and malformed source prefixes are handled safely", async () => {
	assert.equal(await resolveCredential(options("$$OPENAI_API_KEY", "legacy")), "$OPENAI_API_KEY");
	assert.equal(await resolveCredential(options("$!literal-command", "legacy")), "!literal-command");
	for (const source of ["!", "$BAD-NAME", "${UNCLOSED"]) {
		await assert.rejects(
			resolveCredential(options(source, "stale")),
			error => error instanceof CredentialResolutionError && error.category === "invalid-source",
		);
	}
});
