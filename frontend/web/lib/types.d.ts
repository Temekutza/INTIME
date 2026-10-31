// Mirrors ritm/contracts.py v1.3 and EventPatch. No frontend-only event fields.
export type EventType = "task" | "meeting" | "reminder";
export type EventStatus = "planned" | "done";
export interface RitmEvent {
  id: number;
  type: EventType;
  title: string;
  date: string | null;
  time: string | null;
  duration_min: number | null;
  is_deadline: boolean;
  status: EventStatus;
  source: "user" | "archive";
  source_ref: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  workspace_id?: number | null;
}
export interface Workspace {
  id: number;
  name: string;
  is_default: boolean;
}
export type EventPatch = Partial<Pick<RitmEvent, "title" | "date" | "time" | "status">>;
export type View = "tasks" | "reminders" | "calendar";
export type CalendarLayout = "list" | "month";
