from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np


class NpyImage:
    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.data: np.ndarray = np.load(self.path)

    @property
    def name(self) -> str:
        return self.path.name

    @property
    def shape(self) -> tuple[int, ...]:
        return self.data.shape


class Main:
    IMAGE_A_PATH = Path(r"<path>")
    IMAGE_B_PATH = Path(r"<path>")

    def __init__(self):
        self.image_a = NpyImage(self.IMAGE_A_PATH)
        self.image_b = NpyImage(self.IMAGE_B_PATH)

    def compare(self) -> None:
        fig, axes = plt.subplots(1, 2, figsize=(12, 6))
        for ax, image in zip(axes, (self.image_a, self.image_b)):
            ax.imshow(image.data, cmap="gray" if image.data.ndim == 2 else None)
            ax.set_title(f"{image.name} {image.shape}")
            ax.axis("off")
        plt.tight_layout()
        plt.show()

    def run(self) -> None:
        self.compare()


if __name__ == "__main__":
    Main().run()