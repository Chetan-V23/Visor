from pathlib import Path

import matplotlib.pyplot as plt
import nibabel as nib
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


class NiftiImage:
    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.image = nib.load(self.path)
        self.data: np.ndarray = self.image.get_fdata()

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

    def compare_nifti(
        self,
        image_a_path: str | Path,
        image_b_path: str | Path,
        slice_index: int | None = None,
    ) -> None:
        images = (NiftiImage(image_a_path), NiftiImage(image_b_path))
        slices = []
        for image in images:
            if image.data.ndim == 2:
                slices.append(image.data)
            elif image.data.ndim == 3:
                index = image.shape[2] // 2 if slice_index is None else slice_index
                if not 0 <= index < image.shape[2]:
                    raise ValueError(f"Slice index {index} is out of bounds for {image.name}")
                slices.append(image.data[:, :, index])
            else:
                raise ValueError(f"Expected a 2D or 3D NIfTI image: {image.name} {image.shape}")

        fig, axes = plt.subplots(1, 2, figsize=(12, 6))
        for ax, image, data in zip(axes, images, slices):
            ax.imshow(data, cmap="gray")
            ax.set_title(f"{image.name} {image.shape}")
            ax.axis("off")
        plt.tight_layout()
        plt.show()

    def run(self) -> None:
        self.compare()


if __name__ == "__main__":
    Main().run()