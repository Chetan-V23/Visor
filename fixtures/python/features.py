from abc import ABC


class Shape(ABC):
    count: int = 0

    @staticmethod
    def draw(size: int) -> str:
        """Draw a shape."""
        return "ok"

    class Options:
        color: str


def build(shape: Shape) -> Shape:
    return shape