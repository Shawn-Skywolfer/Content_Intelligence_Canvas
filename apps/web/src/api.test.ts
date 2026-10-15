import { describe, expect, it } from "vitest";
import { formatApiError } from "./api";

describe("接口字段错误", () => {
  it("将 FastAPI 的结构化字段校验错误显示为可读中文", () => {
    const text = formatApiError([{ loc: ["body", "max_tokens"], type: "less_than_equal", msg: "Input should be less than or equal to 262144", ctx: { le: 262144 }, input: "secret-must-not-appear" }]);
    expect(text).toBe("最大输出 token：不得大于 262144");
    expect(text).not.toContain("[object Object]");
    expect(text).not.toContain("secret-must-not-appear");
  });
});
