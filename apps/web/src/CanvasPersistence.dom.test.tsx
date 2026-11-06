// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "./App";
import { api, CanvasData, Project } from "./api";
import { setLocale } from "./i18n";
vi.mock("./CanvasView", () => ({ default: ({canvas, onChange}: {canvas: CanvasData | null; onChange:(c:CanvasData)=>void}) => canvas && <div><output data-testid="edges">{canvas.edges.map(e=>e.id).join(",")}</output><button onClick={()=>onChange({...canvas,viewport:{x:17,y:0,zoom:1}})}>调整画布</button></div> }));
const project: Project={id:"p",name:"项目",idea:"问题",brief:"",status:"active",created_at:"",updated_at:""};
const node=(id:string)=>({id,type:"note",title:id,body:"",summary:"",status:"exploring",locked:false,x:0,y:0,width:300,height:200,metadata:{},created_by:"user"});
const original:CanvasData={id:"c",project_id:"p",nodes:[node("a"),node("b")],edges:[],viewport:{x:0,y:0,zoom:1},updated_at:"2026-10-28T00:00:00Z"};
const canonical:CanvasData={...original,updated_at:"2026-10-28T00:01:00Z",edges:[{id:"ai-source",source_node_id:"a",target_node_id:"b",relation:"derived_from",metadata:{}}]};
beforeEach(()=>{setLocale("zh-CN");vi.spyOn(api,"health").mockResolvedValue({status:"ok",phase:""});vi.spyOn(api,"listProjects").mockResolvedValue([project]);vi.spyOn(api,"listSources").mockResolvedValue([]);vi.spyOn(api,"listAssets").mockResolvedValue([]);});
afterEach(()=>{cleanup();vi.restoreAllMocks();});
it("离开白板前保存并采用服务端合并后的连线，返回时重新读取完整图",async()=>{
  const get=vi.spyOn(api,"getCanvas").mockResolvedValueOnce(original).mockResolvedValue(canonical);
  const save=vi.spyOn(api,"saveCanvas").mockResolvedValue(canonical);
  const view=render(<App/>);await waitFor(()=>expect(view.getByText("项目",{selector:"h3"})).toBeTruthy());
  fireEvent.click(view.getByRole("button",{name:"内容白板"}));await view.findByText("调整画布");
  fireEvent.click(view.getByText("调整画布"));fireEvent.click(view.getByRole("button",{name:"项目"}));
  await waitFor(()=>expect(view.queryByText("调整画布")).toBeNull());expect(save).toHaveBeenCalledTimes(1);
  fireEvent.click(view.getByRole("button",{name:"内容白板"}));await waitFor(()=>expect(view.getByTestId("edges").textContent).toBe("ai-source"));
  fireEvent.click(view.getByText("调整画布"));fireEvent.click(view.getByRole("button",{name:"项目"}));
  await waitFor(()=>expect(save).toHaveBeenCalledTimes(2));expect(save.mock.calls[1][1].edges[0].id).toBe("ai-source");expect(save.mock.calls[1][1].updated_at).toBe(canonical.updated_at);expect(get.mock.calls.length).toBeGreaterThanOrEqual(2);
});
it("已有保存请求运行时，切换页面不重复提交旧快照",async()=>{
  vi.spyOn(api,"getCanvas").mockResolvedValue(original);
  let finish!:(c:CanvasData)=>void;
  const save=vi.spyOn(api,"saveCanvas").mockImplementation(()=>new Promise(r=>{finish=r;}));
  const view=render(<App/>);await waitFor(()=>expect(view.getByText("项目",{selector:"h3"})).toBeTruthy());
  fireEvent.click(view.getByRole("button",{name:"内容白板"}));await view.findByText("调整画布");fireEvent.click(view.getByText("调整画布"));
  await waitFor(()=>expect(save).toHaveBeenCalledTimes(1),{timeout:2000});fireEvent.click(view.getByRole("button",{name:"项目"}));
  expect(view.queryByText("调整画布")).toBeTruthy();finish(canonical);
  await waitFor(()=>expect(view.queryByText("调整画布")).toBeNull());expect(save).toHaveBeenCalledTimes(1);
});
