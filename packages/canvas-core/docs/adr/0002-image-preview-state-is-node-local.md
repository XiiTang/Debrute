# Image Preview State Is Node Local

Each Canvas image node owns its loaded, next, error, retry, and source-revision
state; culling changes shell display without ending that state. A shared
preview-resource scheduler limits and defers starts but does not own resource
results or a global image loading plan. This was chosen over a Canvas-wide image
asset runtime so camera movement and virtualization cannot erase loaded images,
quality replacements can hand off without placeholder flashes, and one source
change or failure invalidates only its node. The trade-off is stable mounting of
image nodes while they remain on the active Canvas, with expensive work bounded
by culling and the shared scheduler instead of component destruction.
