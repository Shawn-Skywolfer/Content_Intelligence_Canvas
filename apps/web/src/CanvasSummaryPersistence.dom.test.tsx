// @vitest-environment jsdom
import { act, render, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import CanvasView from "./CanvasView";
import { api, CanvasData, CanvasNode, Project } from "./api";
import { setLocale } from "./i18n";
it("离开白板后返回的摘要不再把旧图写回父页面",async()=>{
  setLocale("zh-CN");
  vi.stubGlobal("ResizeObserver",class{observe(){} unobserve(){} disconnect(){}});
  const node:CanvasNode={id:"a",type:"note",title:"原始节点",body:"待总结正文",status:"exploring",locked:false,x:0,y:0,width:300,height:200,metadata:{},created_by:"user"};
  const board:CanvasData={id:"c",project_id:"p",nodes:[node],edges:[],viewport:{x:0,y:0,zoom:1},updated_at:""};
  const project:Project={id:"p",name:"测试",idea:"",brief:"",status:"active",created_at:"",updated_at:""};
  vi.spyOn(api,"listMagicJobs").mockResolvedValue([]);vi.spyOn(api,"listContentFormats").mockResolvedValue([]);vi.spyOn(api,"activeProvider").mockResolvedValue({provider_id:null,model_name:null});
  let finish!:(n:CanvasNode)=>void;
  const summarize=vi.spyOn(api,"summarizeNode").mockImplementation(()=>new Promise(r=>{finish=r;}));
  const changed=vi.fn();
  const view=render(<CanvasView project={project} canvas={board} selectedIds={[]} setSelectedIds={()=>{}} onChange={changed} onRefresh={async()=>{}} beforeGenerate={async()=>{}} setStatus={()=>{}}/>);
  try {
    await waitFor(()=>expect(summarize).toHaveBeenCalledTimes(1),{timeout:2500});
    view.unmount();changed.mockClear();
    await act(async()=>{finish({...node,summary:"完整摘要"});await Promise.resolve();});
    expect(changed).not.toHaveBeenCalled();
  } finally {view.unmount();vi.restoreAllMocks();}
});
