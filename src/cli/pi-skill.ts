import controlSkill from "../../skills/wolfpack-tailnet-control/SKILL.md" with { type: "text" };
import controlSkillReferences from "../../skills/wolfpack-tailnet-control/references.md" with { type: "text" };

export const WOLFPACK_PI_CONTROL_SKILL_FILES = [
  { filename: "SKILL.md", content: controlSkill },
  { filename: "references.md", content: controlSkillReferences },
] as const;
