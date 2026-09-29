"""Create the Tampermonkey ZIP from exactly one source file (Python standard library)."""
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

root = Path(__file__).resolve().parents[1]
source = root / 'pixiv-bookmark-analyzer-prototype.user.js'
output = root / 'dist' / 'pixiv-bookmark-analyzer-install.zip'
output.parent.mkdir(parents=True, exist_ok=True)
with ZipFile(output, 'w', ZIP_DEFLATED) as archive:
    archive.write(source, source.name)
with ZipFile(output) as archive:
    assert archive.namelist() == [source.name]
    assert archive.read(source.name) == source.read_bytes()
    assert archive.testzip() is None
print(output.relative_to(root))
