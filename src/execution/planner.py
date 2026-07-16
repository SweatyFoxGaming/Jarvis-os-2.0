"""
Planner – responsible for decomposing a Goal into a structured plan of Tasks.
"""

import logging
from typing import List, Optional
from uuid import uuid4

from src.core.models import Goal, Task, ResourceBudget, ExecutionState
from src.core.registry import CapabilityRegistry
from src.core.event_bus import EventBus
from src.core.models import Event

logger = logging.getLogger(__name__)


class Planner:
    """
    Plans execution by translating a Goal into a set of Tasks.
    """

    def __init__(self, cap_registry: CapabilityRegistry, event_bus: EventBus):
        self.cap_registry = cap_registry
        self.event_bus = event_bus
        logger.info("[Planner] Initialized.")

    def create_plan(self, goal: Goal) -> List[Task]:
        """
        Create a plan for the given Goal. Returns a list of Tasks.
        """
        logger.info(f"[Planner] Creating plan for Goal {goal.uuid}: {goal.title[:50]}...")

        capability_name = self._select_capability(goal)

        if not capability_name:
            logger.warning(f"[Planner] No suitable capability found for Goal {goal.uuid}. Falling back to 'research_specialist'.")
            capability_name = "research_specialist"

        # Create a Task with the goal_uuid and budget constraints
        # IMPORTANT: Do NOT set 'priority' – it's not a field on Task.
        task = Task(
            goal_uuid=goal.uuid,
            creator_id="Planner",
            target_capability=capability_name,
            state=ExecutionState.CREATED,
            resource_budget=self._derive_resource_budget(goal),
            input_data={"goal_description": goal.description},
        )

        tasks = [task]

        self.event_bus.publish(Event(
            event_type="PlanCreated",
            source="Planner",
            payload={
                "goal_id": str(goal.uuid),
                "task_ids": [str(t.uuid) for t in tasks],
                "task_count": len(tasks),
            }
        ))

        logger.info(f"[Planner] Plan created for Goal {goal.uuid} with {len(tasks)} task(s).")
        return tasks

    def _select_capability(self, goal: Goal) -> Optional[str]:
        capabilities = self.cap_registry.list_capabilities()
        if not capabilities:
            return None

        text = (goal.title + " " + goal.description).lower()

        keyword_map = {
            "research": ["research_specialist"],
            "code": ["coding_specialist"],
            "write": ["coding_specialist"],
            "program": ["coding_specialist"],
            "time": ["time_service"],
            "date": ["time_service"],
            "system": ["system_info"],
            "hardware": ["system_info"],
            "weather": ["weather"],
            "command": ["system_control"],
            "execute": ["system_control"],
            "email": ["email", "email_reader"],
            "calendar": ["calendar"],
            "github": ["github"],
            "news": ["news"],
            "todo": ["todo"],
            "note": ["notes"],
        }

        for keyword, candidates in keyword_map.items():
            if keyword in text:
                for candidate in candidates:
                    if candidate in capabilities:
                        return candidate

        return capabilities[0] if capabilities else None

    def _derive_resource_budget(self, goal: Goal) -> ResourceBudget:
        return ResourceBudget(
            ram_limit_mb=256,
            token_limit=goal.budget.token_budget,
            time_limit_sec=goal.budget.time_budget_sec,
        )
