# Workbench Owns Its Visual Primitive Layer

Workbench uses one repository-owned semantic token source and one small public
React primitive layer instead of adopting a general visual component library or
allowing feature-local UI systems. Feature code composes those primitives and
owns only feature layout and intrinsic geometry; Canvas and terminal exceptions
remain explicitly bounded. This trades library-provided breadth for stable
creative-tool density, unified accessibility and theme semantics, and source
ownership that prevents independent feature styling systems from drifting.
