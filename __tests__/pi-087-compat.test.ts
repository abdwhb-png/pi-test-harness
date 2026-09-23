import { expect, it } from "vitest";
import { calls, createTestSession, says, when } from "../src/index.js";

it("keeps a mocked built-in tool active after Pi rebuilds its tool loadout", async () => {
	let mockCalls = 0;
	const session = await createTestSession({
		mockTools: {
			read: () => {
				mockCalls += 1;
				return "fixture read result";
			},
		},
		extensionFactories: [
			(pi) => {
				pi.on("before_agent_start", () => {
					pi.setActiveTools(["read"]);
				});
			},
		],
	});
	try {
		await session.run(
			when("Read fixture", [
				calls("read", { path: "/pi-test-harness-missing-fixture" }),
				says("Done"),
			]),
		);
		expect(mockCalls).toBe(1);
		expect(session.events.toolResultsFor("read")[0]?.text).toBe("fixture read result");
	} finally {
		session.dispose();
	}
});
