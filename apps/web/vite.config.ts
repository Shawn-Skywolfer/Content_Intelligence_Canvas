import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const prefix = loadEnv(mode, process.cwd(), "VITE_").VITE_API_BASE ?? "";
  const servicePrefix = prefix.startsWith("/") ? prefix : "";
  if (servicePrefix && !/^\/[A-Za-z]+$/.test(servicePrefix)) throw new Error("部署前缀必须为斜杠加英文服务名");
  return {
    base: "./",
    build: { emptyOutDir: true },
    plugins: [react(), {
      name: "服务路径资源基准",
      // 平台入口即使不带尾斜杠，浏览器也应从服务目录加载相对资源。
      transformIndexHtml: () => servicePrefix ? [{ tag: "base", attrs: { href: `${servicePrefix}/` }, injectTo: "head-prepend" }] : [],
    }],
    server: { port: 5173 },
  };
});
