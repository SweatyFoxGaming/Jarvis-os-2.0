import json
from typing import Dict, Any, Optional
from pydantic import BaseModel, Field


class ProtocolError(Exception):
    """Raised when an IPC message fails schema or security verification."""
    pass


class IPCResponse(BaseModel):
    event_id: str
    success: bool = True
    result: Optional[Any] = None
    error: Optional[str] = None


def parse_control_message(raw_message: str) -> Dict[str, Any]:
    """Parses and validates incoming raw JSON IPC messages."""
    try:
        data = json.loads(raw_message)
    except json.JSONDecodeError as err:
        raise ProtocolError(f"Invalid JSON format: {err}")

    if not isinstance(data, dict):
        raise ProtocolError("IPC payload must be a JSON object")

    if "action_type" not in data:
        raise ProtocolError("Missing required field 'action_type'")

    return data
