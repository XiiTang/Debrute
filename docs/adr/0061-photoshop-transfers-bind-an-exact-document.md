# Photoshop Transfers Bind An Explicit Document

Runtime projects every open Photoshop Document from every live Photoshop plugin
session to every Workbench, and the user explicitly chooses one document for a
Debrute-to-Photoshop transfer. The request binds the selected plugin session and
stable document identity across download and placement; activation changes
cannot retarget it, and closing it makes placement fail. This is chosen over
showing only the active document or resolving focus at final placement because
asynchronous transfer must not silently put an Embedded Smart Object into a
different work product.
