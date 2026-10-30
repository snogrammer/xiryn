CREATE INDEX `routine_runs_thread_idx` ON `routine_runs` (`thread_id`);--> statement-breakpoint
CREATE INDEX `routine_runs_turn_idx` ON `routine_runs` (`turn_id`);--> statement-breakpoint
CREATE INDEX `routines_agent_idx` ON `routines` (`agent_id`);--> statement-breakpoint
CREATE INDEX `routines_squad_idx` ON `routines` (`squad_id`);--> statement-breakpoint
CREATE INDEX `routines_thread_idx` ON `routines` (`thread_id`);--> statement-breakpoint
CREATE INDEX `turns_thread_idx` ON `turns` (`thread_id`);--> statement-breakpoint
CREATE INDEX `turns_agent_idx` ON `turns` (`agent_id`);--> statement-breakpoint
CREATE INDEX `vault_approvals_agent_idx` ON `vault_approvals` (`agent_id`);--> statement-breakpoint
CREATE INDEX `vault_approvals_item_idx` ON `vault_approvals` (`item_id`);