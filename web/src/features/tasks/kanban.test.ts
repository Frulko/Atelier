import {describe,it,expect} from "vitest";
import type {Task} from "../../lib/types";
import {columnOf} from "./kanban";
const task=(patch:Partial<Task>)=>({status:"queued",board_column:null,waiting_question_id:null,...patch}) as Task;
describe("Kanban workflow",()=>{
  it("uses execution state by default, keeping completed proposals in review",()=>{
    expect(columnOf(task({}))).toBe("todo");
    expect(columnOf(task({status:"running"}))).toBe("doing");
    expect(columnOf(task({status:"done"}))).toBe("review");
    expect(columnOf(task({status:"failed"}))).toBe("blocked");
    expect(columnOf(task({status:"no_changes"}))).toBe("done");
  });
  it("preserves manual organization but always surfaces pending decisions",()=>{
    expect(columnOf(task({status:"done",board_column:"done"}))).toBe("done");
    expect(columnOf(task({board_column:"done",waiting_question_id:"q"}))).toBe("blocked");
  });
});
