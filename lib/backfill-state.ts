export type StepStatus = "pending" | "running" | "done" | "skipped";

export interface BackfillState {
  started: boolean;
  done: boolean;
  error: string | null;
  steps: {
    order_category_facts: StepStatus;
    daily_order_count: StepStatus;
    daily_summary: StepStatus;
  };
}

export const backfillState: BackfillState = {
  started: false,
  done: false,
  error: null,
  steps: {
    order_category_facts: "pending",
    daily_order_count: "pending",
    daily_summary: "pending",
  },
};
