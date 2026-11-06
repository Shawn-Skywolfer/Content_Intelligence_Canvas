import { beforeEach as resetTestLanguage } from "vitest";
import { setLocale as setTestLocale } from "./i18n";
resetTestLanguage(() => setTestLocale("zh-CN"));
import { expect, it } from "vitest";
import { cleanSourcePath } from "./sourcePath";
it("保留中文、空格、单引号和 UNC 目录，剥离工具警告", () => {
  expect(cleanSourcePath("[WARNING] Ignore caches that are heterogeneousD:\\LLM-Wiki\\wiki")).toBe("D:\\LLM-Wiki\\wiki");
  expect(cleanSourcePath('"D:\\知识库\\O\'Brien 文档"')).toBe("D:\\知识库\\O'Brien 文档");
  expect(cleanSourcePath("[WARNING] something\\\\server\\中文 Wiki")).toBe("\\\\server\\中文 Wiki");
  expect(cleanSourcePath("[WARNING] something\n/Users/shawn/知识库")).toBe("/Users/shawn/知识库");
});
