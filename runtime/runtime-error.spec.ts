import { assertEquals } from "@std/assert";
import { RuntimeError, toCloudConnectorError } from "./runtime-error.ts";

Deno.test("toCloudConnectorError preserves RuntimeError codes", () => {
    assertEquals(
        toCloudConnectorError(new RuntimeError("HOOK_REJECTED", "Rejected")),
        { code: "HOOK_REJECTED", message: "Rejected" },
    );
});

Deno.test("toCloudConnectorError normalizes unexpected errors", () => {
    assertEquals(toCloudConnectorError(new Error("Boom")), {
        code: "UNEXPECTED_ERROR",
        message: "Boom",
    });
    assertEquals(toCloudConnectorError("plain failure"), {
        code: "UNEXPECTED_ERROR",
        message: "plain failure",
    });
});
