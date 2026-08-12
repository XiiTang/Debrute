//! Session-local Project filesystem index shared by Explorer and Canvas.

use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    path::{Path, PathBuf},
};

use super::{
    ProjectDirectoryPath, ProjectDirectoryState, ProjectError, ProjectPathKind, ProjectTreeEntry,
    compare_project_tree_entries, list_project_directory, watcher::ProjectWatchPath,
};

#[derive(Clone)]
struct IndexedProjectTreeEntry {
    public: ProjectTreeEntry,
    identity: debrute_native_fs::PathIdentity,
}

#[derive(Clone)]
pub(crate) struct ProjectTree {
    root: PathBuf,
    root_entry: ProjectTreeEntry,
    entries: BTreeMap<String, IndexedProjectTreeEntry>,
}

#[derive(Default)]
pub(crate) struct ProjectTreeChange {
    pub(crate) confirmed_missing_paths: Vec<String>,
    pub(crate) identity_reset_paths: Vec<String>,
}

impl ProjectTree {
    pub(crate) fn new(root: PathBuf) -> Self {
        Self {
            root,
            root_entry: ProjectTreeEntry {
                project_relative_path: String::new(),
                kind: super::ProjectPathKind::Directory,
                size_bytes: None,
                directory_state: Some(super::ProjectDirectoryState::Unloaded),
                directory_error: None,
            },
            entries: BTreeMap::new(),
        }
    }

    pub(crate) fn ordered_entries(&self) -> Vec<ProjectTreeEntry> {
        let mut siblings = HashMap::<&str, Vec<&ProjectTreeEntry>>::new();
        for indexed in self.entries.values() {
            let entry = &indexed.public;
            let parent = entry
                .project_relative_path
                .rsplit_once('/')
                .map_or("", |(parent, _)| parent);
            siblings.entry(parent).or_default().push(entry);
        }
        for entries in siblings.values_mut() {
            entries.sort_by(|left, right| compare_project_tree_entries(left, right));
        }
        let mut ordered = Vec::with_capacity(self.entries.len() + 1);
        ordered.push(self.root_entry.clone());
        let mut pending = siblings
            .get("")
            .into_iter()
            .flatten()
            .rev()
            .copied()
            .collect::<Vec<_>>();
        while let Some(entry) = pending.pop() {
            ordered.push(entry.clone());
            if entry.kind == ProjectPathKind::Directory
                && let Some(children) = siblings.get(entry.project_relative_path.as_str())
            {
                pending.extend(children.iter().rev().copied());
            }
        }
        ordered
    }

    pub(crate) fn entry(&self, path: &str) -> Option<&ProjectTreeEntry> {
        if path.is_empty() {
            Some(&self.root_entry)
        } else {
            self.entries.get(path).map(|entry| &entry.public)
        }
    }

    pub(crate) fn is_loaded_dependency(&self, path: &str) -> bool {
        let parent = path.rsplit_once('/').map_or("", |(parent, _)| parent);
        parent.is_empty() || self.directory_was_loaded(parent)
    }

    pub(crate) fn reload_loaded(&mut self) -> Result<ProjectTreeChange, ProjectError> {
        self.refresh_transaction(Self::reload_loaded_inner)
    }

    fn reload_loaded_inner(&mut self) -> Result<ProjectTreeChange, ProjectError> {
        let mut change = ProjectTreeChange::default();
        for directory in self.loaded_directory_paths() {
            if change.invalidates(&directory) {
                continue;
            }
            let admitted = ProjectDirectoryPath::parse(&directory)?;
            match list_project_directory(&self.root, &admitted) {
                Ok(children) => {
                    change.extend(self.replace_directory_entries(&directory, children)?);
                }
                Err(error) if directory.is_empty() => return Err(error),
                Err(error) => self.set_directory_error(&directory, &error.to_string()),
            }
        }
        normalize_change(&mut change);
        Ok(change)
    }

    pub(crate) fn load_directories(
        &mut self,
        directories: &[String],
    ) -> Result<ProjectTreeChange, ProjectError> {
        self.refresh_transaction(|tree| tree.load_directories_inner(directories))
    }

    fn load_directories_inner(
        &mut self,
        directories: &[String],
    ) -> Result<ProjectTreeChange, ProjectError> {
        let mut directories = directories
            .iter()
            .map(|directory| ProjectDirectoryPath::parse(directory))
            .collect::<Result<Vec<_>, _>>()?;
        directories.sort_by_key(|path| path.matches('/').count());
        directories.dedup();
        directories.retain(|directory| !self.directory_is_loaded(directory));
        if directories.is_empty() {
            return Ok(ProjectTreeChange::default());
        }

        let mut blocked_roots = Vec::<String>::new();
        let mut change = ProjectTreeChange::default();
        for directory in directories {
            if change.invalidates(&directory)
                || blocked_roots
                    .iter()
                    .any(|root| super::project_path_is_same_or_descendant(&directory, root))
            {
                continue;
            }
            match list_project_directory(&self.root, &directory) {
                Ok(children) => {
                    change.extend(self.replace_directory_entries(&directory, children)?);
                }
                Err(error)
                    if matches!(&error, ProjectError::Io(error) if error.kind() == std::io::ErrorKind::NotFound)
                        && !directory.is_empty() =>
                {
                    self.remove_path(&directory);
                    change.confirmed_missing_paths.push(directory.to_string());
                    blocked_roots.push(directory.into_string());
                }
                Err(error) if directory.is_empty() => return Err(error),
                Err(error) => {
                    self.set_directory_error(&directory, &error.to_string());
                    blocked_roots.push(directory.into_string());
                }
            }
        }
        normalize_change(&mut change);
        Ok(change)
    }

    pub(crate) fn refresh_watched_paths(
        &mut self,
        paths: &[ProjectWatchPath],
    ) -> Result<ProjectTreeChange, ProjectError> {
        self.refresh_transaction(|tree| tree.refresh_watched_paths_inner(paths))
    }

    pub(crate) fn refresh_committed_content_change(
        &mut self,
        project_relative_path: &str,
        expected_identity: debrute_native_fs::PathIdentity,
    ) -> Result<ProjectTreeChange, ProjectError> {
        let mut change = self.refresh_watched_paths(&[ProjectWatchPath::modified(
            project_relative_path.to_owned(),
        )])?;
        if self
            .entries
            .get(project_relative_path)
            .is_some_and(|entry| entry.identity == expected_identity)
        {
            change
                .identity_reset_paths
                .retain(|path| path != project_relative_path);
        }
        Ok(change)
    }

    fn refresh_watched_paths_inner(
        &mut self,
        paths: &[ProjectWatchPath],
    ) -> Result<ProjectTreeChange, ProjectError> {
        let reset_candidates = paths
            .iter()
            .filter(|path| path.resets_identity)
            .map(|path| {
                (
                    path.project_relative_path.clone(),
                    self.entries
                        .get(&path.project_relative_path)
                        .map(|entry| entry.identity),
                )
            })
            .collect::<Vec<_>>();
        let directories = paths
            .iter()
            .flat_map(|path| {
                let parent = path
                    .project_relative_path
                    .rsplit_once('/')
                    .map_or_else(String::new, |(parent, _)| parent.to_owned());
                [parent, path.project_relative_path.clone()]
            })
            .filter(|directory| self.directory_was_loaded(directory))
            .collect::<BTreeSet<_>>();
        let mut change = ProjectTreeChange::default();
        for directory in directories {
            if change.invalidates(&directory) {
                continue;
            }
            let admitted = ProjectDirectoryPath::parse(&directory)?;
            match list_project_directory(&self.root, &admitted) {
                Ok(children) => {
                    change.extend(self.replace_directory_entries(&directory, children)?);
                }
                Err(error) if directory.is_empty() => return Err(error),
                Err(error) => self.set_directory_error(&directory, &error.to_string()),
            }
        }
        change.identity_reset_paths.extend(
            reset_candidates
                .into_iter()
                .filter(|(path, previous)| {
                    let current = self.entries.get(path).map(|entry| entry.identity);
                    previous.is_none() || previous != &current
                })
                .map(|(path, _)| path),
        );
        normalize_change(&mut change);
        Ok(change)
    }

    pub(crate) fn refresh_after_mutation(
        &mut self,
        removed_paths: &[String],
        rewrites: &[(String, String)],
    ) -> Result<ProjectTreeChange, ProjectError> {
        self.refresh_transaction(|tree| {
            tree.rewrite_paths(removed_paths, rewrites);
            tree.refresh_after_mutation_inner(removed_paths, rewrites)
        })
    }

    fn refresh_after_mutation_inner(
        &mut self,
        removed_paths: &[String],
        rewrites: &[(String, String)],
    ) -> Result<ProjectTreeChange, ProjectError> {
        let changed_paths = removed_paths
            .iter()
            .cloned()
            .chain(
                rewrites
                    .iter()
                    .flat_map(|(source, target)| [source.clone(), target.clone()]),
            )
            .collect::<HashSet<_>>();
        let directories = changed_paths
            .iter()
            .map(|path| parent_path(path).to_owned())
            .filter(|directory| self.directory_was_loaded(directory))
            .collect::<BTreeSet<_>>();
        let mut change = ProjectTreeChange::default();
        for directory in directories {
            if change.invalidates(&directory) {
                continue;
            }
            let admitted = ProjectDirectoryPath::parse(&directory)?;
            match list_project_directory(&self.root, &admitted) {
                Ok(children) => {
                    change.extend(self.replace_directory_entries(&directory, children)?);
                }
                Err(error) if directory.is_empty() => return Err(error),
                Err(error) => self.set_directory_error(&directory, &error.to_string()),
            }
        }
        normalize_change(&mut change);
        Ok(change)
    }

    fn refresh_transaction(
        &mut self,
        refresh: impl FnOnce(&mut Self) -> Result<ProjectTreeChange, ProjectError>,
    ) -> Result<ProjectTreeChange, ProjectError> {
        let checkpoint = self.clone();
        match refresh(self) {
            Ok(change) => Ok(change),
            Err(error) => {
                *self = checkpoint;
                Err(error)
            }
        }
    }

    fn directory_is_loaded(&self, directory: &str) -> bool {
        if directory.is_empty() {
            return matches!(
                self.root_entry.directory_state,
                Some(ProjectDirectoryState::Loaded)
            );
        }
        self.entries.get(directory).is_some_and(|entry| {
            entry.public.kind == ProjectPathKind::Directory
                && matches!(
                    entry.public.directory_state,
                    Some(ProjectDirectoryState::Loaded)
                )
        })
    }

    fn directory_was_loaded(&self, directory: &str) -> bool {
        if directory.is_empty() {
            return matches!(
                self.root_entry.directory_state,
                Some(ProjectDirectoryState::Loaded | ProjectDirectoryState::Error)
            );
        }
        self.entries.get(directory).is_some_and(|entry| {
            entry.public.kind == ProjectPathKind::Directory
                && matches!(
                    entry.public.directory_state,
                    Some(ProjectDirectoryState::Loaded | ProjectDirectoryState::Error)
                )
        })
    }

    fn loaded_directory_paths(&self) -> Vec<String> {
        std::iter::once(String::new())
            .chain(
                self.entries
                    .values()
                    .filter(|entry| {
                        entry.public.kind == ProjectPathKind::Directory
                            && matches!(
                                entry.public.directory_state,
                                Some(ProjectDirectoryState::Loaded | ProjectDirectoryState::Error)
                            )
                    })
                    .map(|entry| entry.public.project_relative_path.clone()),
            )
            .collect()
    }

    fn replace_directory_entries(
        &mut self,
        directory: &str,
        children: Vec<ProjectTreeEntry>,
    ) -> Result<ProjectTreeChange, ProjectError> {
        let mut identified_children = Vec::with_capacity(children.len());
        let mut disappeared_children = Vec::new();
        for child in children {
            if let Some(identity) = path_identity(&self.root, &child.project_relative_path)? {
                identified_children.push((child, identity));
            } else {
                disappeared_children.push(child.project_relative_path);
            }
        }
        let direct_child = |path: &str| {
            path.rsplit_once('/')
                .map_or(directory.is_empty(), |(parent, _)| parent == directory)
        };
        let missing = self
            .entries
            .keys()
            .filter(|path| direct_child(path))
            .filter(|path| {
                !identified_children
                    .iter()
                    .any(|(entry, _)| entry.project_relative_path == **path)
            })
            .cloned()
            .chain(disappeared_children)
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        for path in &missing {
            self.remove_path(path);
        }

        let mut recreated = Vec::new();
        for (mut child, identity) in identified_children {
            let previous = self.entries.get(&child.project_relative_path).cloned();
            let same_object = previous.as_ref().is_some_and(|previous| {
                previous.identity == identity && previous.public.kind == child.kind
            });
            if same_object {
                if child.kind == ProjectPathKind::Directory
                    && let Some(previous) = &previous
                {
                    child.directory_state = previous.public.directory_state;
                    child
                        .directory_error
                        .clone_from(&previous.public.directory_error);
                }
            } else if previous.is_some() {
                recreated.push(child.project_relative_path.clone());
                self.remove_path(&child.project_relative_path);
            }
            self.entries.insert(
                child.project_relative_path.clone(),
                IndexedProjectTreeEntry {
                    public: child,
                    identity,
                },
            );
        }
        if !directory.is_empty()
            && let Some(entry) = self.entries.get_mut(directory)
        {
            entry.public.directory_state = Some(ProjectDirectoryState::Loaded);
            entry.public.directory_error = None;
        } else if directory.is_empty() {
            self.root_entry.directory_state = Some(ProjectDirectoryState::Loaded);
            self.root_entry.directory_error = None;
        }
        Ok(ProjectTreeChange {
            confirmed_missing_paths: missing,
            identity_reset_paths: recreated,
        })
    }

    fn set_directory_error(&mut self, directory: &str, message: &str) {
        if directory.is_empty() {
            self.root_entry.directory_state = Some(ProjectDirectoryState::Error);
            self.root_entry.directory_error = Some(message.to_owned());
            return;
        }
        if let Some(entry) = self.entries.get_mut(directory)
            && entry.public.kind == ProjectPathKind::Directory
        {
            entry.public.directory_state = Some(ProjectDirectoryState::Error);
            entry.public.directory_error = Some(message.to_owned());
        }
    }

    fn remove_path(&mut self, path: &str) {
        self.entries
            .retain(|current, _| current != path && !current.starts_with(&format!("{path}/")));
    }

    fn rewrite_paths(&mut self, removed_paths: &[String], rewrites: &[(String, String)]) {
        self.entries = std::mem::take(&mut self.entries)
            .into_values()
            .filter(|entry| {
                !removed_paths.iter().any(|removed| {
                    super::project_path_is_same_or_descendant(
                        &entry.public.project_relative_path,
                        removed,
                    )
                })
            })
            .map(|mut entry| {
                entry.public.project_relative_path = rewrites.iter().fold(
                    entry.public.project_relative_path,
                    |current, (source, target)| {
                        super::rewrite_project_path(&current, source, target)
                    },
                );
                (entry.public.project_relative_path.clone(), entry)
            })
            .collect();
    }
}

fn path_identity(
    root: &Path,
    path: &str,
) -> Result<Option<debrute_native_fs::PathIdentity>, ProjectError> {
    match debrute_native_fs::path_identity(&root.join(path)) {
        Ok(identity) => Ok(Some(identity)),
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
            ) =>
        {
            Ok(None)
        }
        Err(error) => Err(ProjectError::Io(error)),
    }
}

fn parent_path(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(parent, _)| parent)
}

fn normalize_change(change: &mut ProjectTreeChange) {
    change.confirmed_missing_paths.sort();
    change.confirmed_missing_paths.dedup();
    change.identity_reset_paths.sort();
    change.identity_reset_paths.dedup();
}

impl ProjectTreeChange {
    fn extend(&mut self, other: Self) {
        self.confirmed_missing_paths
            .extend(other.confirmed_missing_paths);
        self.identity_reset_paths.extend(other.identity_reset_paths);
    }

    fn invalidates(&self, path: &str) -> bool {
        self.confirmed_missing_paths
            .iter()
            .chain(&self.identity_reset_paths)
            .any(|root| super::project_path_is_same_or_descendant(path, root))
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use uuid::Uuid;

    use super::*;

    #[test]
    fn replaced_directory_discards_descendants_and_stays_unloaded() {
        let root = fixture_root();
        fs::create_dir_all(root.join("assets/nested")).unwrap();
        fs::write(root.join("assets/nested/old.txt"), "old").unwrap();
        let mut tree = loaded_tree(&root, &["assets", "assets/nested"]);

        fs::remove_dir_all(root.join("assets")).unwrap();
        fs::create_dir(root.join("assets")).unwrap();
        fs::write(root.join("assets/new.txt"), "new").unwrap();

        let change = tree.reload_loaded().unwrap();

        assert_eq!(change.identity_reset_paths, vec!["assets"]);
        assert_eq!(
            tree.entry("assets").unwrap().directory_state,
            Some(ProjectDirectoryState::Unloaded)
        );
        assert!(tree.entry("assets/nested").is_none());
        assert!(tree.entry("assets/nested/old.txt").is_none());
        assert!(tree.entry("assets/new.txt").is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn same_directory_identity_retains_loaded_descendants() {
        let root = fixture_root();
        fs::create_dir_all(root.join("assets/nested")).unwrap();
        fs::write(root.join("assets/nested/old.txt"), "old").unwrap();
        let mut tree = loaded_tree(&root, &["assets", "assets/nested"]);

        fs::write(root.join("assets/new.txt"), "new").unwrap();
        tree.reload_loaded().unwrap();

        assert_eq!(
            tree.entry("assets").unwrap().directory_state,
            Some(ProjectDirectoryState::Loaded)
        );
        assert_eq!(
            tree.entry("assets/nested").unwrap().directory_state,
            Some(ProjectDirectoryState::Loaded)
        );
        assert!(tree.entry("assets/nested/old.txt").is_some());
        assert!(tree.entry("assets/new.txt").is_some());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn ordered_entries_are_root_first_directory_first_flat_dfs() {
        let root = fixture_root();
        fs::create_dir_all(root.join("a/nested")).unwrap();
        fs::create_dir(root.join("z")).unwrap();
        fs::write(root.join("a/child.txt"), "child").unwrap();
        fs::write(root.join("root.txt"), "root").unwrap();
        let tree = loaded_tree(&root, &["a"]);

        assert_eq!(
            tree.ordered_entries()
                .into_iter()
                .map(|entry| entry.project_relative_path)
                .collect::<Vec<_>>(),
            ["", "a", "a/nested", "a/child.txt", "z", "root.txt"]
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn explicit_load_retries_a_directory_error_and_recovers_loaded_state() {
        let root = fixture_root();
        fs::create_dir(root.join("assets")).unwrap();
        let mut tree = loaded_tree(&root, &["assets"]);
        tree.set_directory_error("assets", "temporary failure");
        fs::write(root.join("assets/recovered.txt"), "ready").unwrap();

        tree.load_directories(&["assets".to_owned()]).unwrap();

        assert_eq!(
            tree.entry("assets").unwrap().directory_state,
            Some(ProjectDirectoryState::Loaded)
        );
        assert_eq!(tree.entry("assets").unwrap().directory_error, None);
        assert!(tree.entry("assets/recovered.txt").is_some());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn directory_errors_remain_watcher_dependencies_until_they_recover() {
        let root = fixture_root();
        fs::create_dir(root.join("assets")).unwrap();
        let mut tree = loaded_tree(&root, &["assets"]);
        tree.set_directory_error("assets", "temporary failure");

        assert!(tree.is_loaded_dependency("assets/recovered.txt"));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn kind_change_discards_the_previous_subtree() {
        let root = fixture_root();
        fs::create_dir_all(root.join("entry/nested")).unwrap();
        fs::write(root.join("entry/nested/old.txt"), "old").unwrap();
        let mut tree = loaded_tree(&root, &["entry", "entry/nested"]);

        fs::remove_dir_all(root.join("entry")).unwrap();
        fs::write(root.join("entry"), "file").unwrap();
        let change = tree.reload_loaded().unwrap();

        assert_eq!(change.identity_reset_paths, vec!["entry"]);
        assert_eq!(tree.entry("entry").unwrap().kind, ProjectPathKind::File);
        assert!(tree.entry("entry/nested").is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_refresh_preserves_the_complete_tree() {
        let root = fixture_root();
        fs::create_dir(root.join("assets")).unwrap();
        let mut tree = loaded_tree(&root, &["assets"]);
        let before = tree.ordered_entries();

        fs::remove_dir_all(&root).unwrap();
        assert!(tree.reload_loaded().is_err());
        assert_eq!(tree.ordered_entries(), before);
    }

    #[test]
    fn runtime_rename_and_watcher_echo_keep_the_same_identity() {
        let root = fixture_root();
        fs::write(root.join("before.txt"), "content").unwrap();
        let mut tree = loaded_tree(&root, &[]);
        let before_identity = tree.entries["before.txt"].identity;
        let before_kind = tree.entries["before.txt"].public.kind;

        fs::rename(root.join("before.txt"), root.join("after.txt")).unwrap();
        assert_eq!(
            path_identity(&root, "after.txt").unwrap(),
            Some(before_identity)
        );
        assert_eq!(before_kind, ProjectPathKind::File);
        let committed = tree
            .refresh_after_mutation(
                &["after.txt".to_owned()],
                &[("before.txt".to_owned(), "after.txt".to_owned())],
            )
            .unwrap();
        let echoed = tree
            .refresh_watched_paths(&[ProjectWatchPath {
                project_relative_path: "after.txt".to_owned(),
                resets_identity: true,
            }])
            .unwrap();

        assert_eq!(committed.identity_reset_paths, Vec::<String>::new());
        assert!(echoed.identity_reset_paths.is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    fn fixture_root() -> PathBuf {
        let root = std::env::temp_dir().join(format!("debrute-project-tree-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn loaded_tree(root: &Path, directories: &[&str]) -> ProjectTree {
        let mut tree = ProjectTree::new(root.to_owned());
        tree.load_directories(&[String::new()]).unwrap();
        for directory in directories {
            tree.load_directories(&[(*directory).to_owned()]).unwrap();
        }
        tree
    }
}
