from dataclasses import dataclass, field


@dataclass
class ToolError(Exception):
    code: str
    message: str
    action: str = ""
    details: dict = field(default_factory=dict)

    def __str__(self) -> str:
        return f"{self.code}: {self.message}"

    def as_dict(self) -> dict:
        return {"status": "error", "code": self.code, "message": self.message,
                "action": self.action, "details": self.details}
