from semantic_entry.errors import SemanticError
from semantic_entry.images import ImageMetadata


class FakeImageStore:
    def __init__(self):
        self.items = {}
        self.data = {}
        self.calls = []

    async def signed_upload_url(self, path, content_type):
        self.calls.append(("sign", path, content_type))
        return {
            "url": "https://upload.example.test/synthetic",
            "expiresAt": "2026-10-28T00:15:00Z",
            "requiredHeaders": {"Content-Type": content_type},
        }

    async def metadata(self, path):
        self.calls.append(("metadata", path))
        return self.items.get(path)

    async def download(self, path, generation):
        self.calls.append(("download", path, generation))
        if path not in self.items:
            raise SemanticError(404, "image_not_found")
        if self.items[path].generation != generation:
            raise SemanticError(409, "image_changed")
        return self.data[path]

    def add(
        self, path, data=b"\xff\xd8\xff", mime="image/jpeg", size=None, generation="17"
    ):
        self.items[path] = ImageMetadata(
            path, len(data) if size is None else size, mime, generation
        )
        self.data[path] = data
        return self.items[path]
