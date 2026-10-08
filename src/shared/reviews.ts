export const worthVerdicts = ["worth_it", "not_worth_it", "unsure"] as const;
export const usageFrequencies = ["daily", "weekly", "monthly", "rarely", "never"] as const;
export const verdictLabels: Record<(typeof worthVerdicts)[number], string> = {
  worth_it: "Worth it",
  not_worth_it: "Not worth it",
  unsure: "Still deciding",
};
export const usageLabels: Record<(typeof usageFrequencies)[number], string> = {
  daily: "Daily", weekly: "Weekly", monthly: "Monthly", rarely: "Rarely", never: "Never",
};
