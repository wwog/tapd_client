//! Local project and work item values.

use serde::{Deserialize, Serialize};

use crate::error::LocalError;

// Id prefixes keep local records readable next to TAPD ids in logs and links,
// and make a mistyped id obvious instead of silently querying TAPD.
const PROJECT_ID_PREFIX: &str = "lp_";
const WORK_ITEM_ID_PREFIX: &str = "lw_";

/// Project rules are prompt text, so the cap only stops a paste from growing
/// every future prompt without bound.
const MAX_RULE_CHARS: usize = 20_000;

/// Build a project id from a bare UUID. The caller owns UUID generation.
pub fn project_id(uuid_simple: &str) -> String {
    format!("{PROJECT_ID_PREFIX}{}", uuid_simple.trim())
}

/// Build a work item id from a bare UUID. The caller owns UUID generation.
pub fn work_item_id(uuid_simple: &str) -> String {
    format!("{WORK_ITEM_ID_PREFIX}{}", uuid_simple.trim())
}

/// A folder on disk the user works in, with no TAPD workspace behind it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalProject {
    pub id: String,
    pub name: String,
    /// Repository root as the user picked it; this crate never resolves or
    /// canonicalizes paths, so the stored value is exactly what the UI shows.
    pub repo_path: String,
    /// Free-form project rules appended to every local agent prompt. Empty
    /// unless the user wrote them.
    pub rule: String,
    pub created_at: String,
    pub updated_at: String,
}

impl LocalProject {
    pub fn new(id: String, name: &str, repo_path: &str, now: &str) -> Result<Self, LocalError> {
        let name = required(name, LocalError::EmptyProjectName)?;
        let repo_path = required(repo_path, LocalError::EmptyRepoPath)?;
        Ok(Self {
            id,
            name: name.to_owned(),
            repo_path: repo_path.to_owned(),
            rule: String::new(),
            created_at: now.to_owned(),
            updated_at: now.to_owned(),
        })
    }

    /// Replaces the project rules. Empty text clears them; the value is trimmed
    /// and capped because it is pasted into every prompt.
    pub fn set_rule(&mut self, rule: &str, now: &str) {
        self.rule = rule.trim().chars().take(MAX_RULE_CHARS).collect();
        self.updated_at = now.to_owned();
    }

    pub fn rename(&mut self, name: &str, now: &str) -> Result<(), LocalError> {
        self.name = required(name, LocalError::EmptyProjectName)?.to_owned();
        self.updated_at = now.to_owned();
        Ok(())
    }

    pub fn move_to(&mut self, repo_path: &str, now: &str) -> Result<(), LocalError> {
        self.repo_path = required(repo_path, LocalError::EmptyRepoPath)?.to_owned();
        self.updated_at = now.to_owned();
        Ok(())
    }

    /// Name a project from the folder the user just picked, so the create flow
    /// does not demand a name the path already carries.
    pub fn derive_project_name(repo_path: &str) -> String {
        let path = repo_path.trim();
        // Both separators: the path may be pasted from another machine, and the
        // result is only displayed, never used to touch the filesystem.
        match path.rsplit(['/', '\\']).find(|part| !part.is_empty()) {
            Some(component) => component.to_owned(),
            None if !path.is_empty() => path.to_owned(),
            None => "local".to_owned(),
        }
    }
}

/// One item of local work. 「事项」in the UI: it has no TAPD id and only the
/// agent link ties it to anything outside this crate.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkItem {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub description: String,
    pub status: WorkItemStatus,
    /// User-facing importance mark; normal when the item was created without
    /// one. Purely descriptive: it never gates a transition.
    #[serde(default)]
    pub importance: WorkItemImportance,
    /// Set while an agent task works on this item; the task lives elsewhere.
    pub agent_task_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkItemStatus {
    Pending,
    InProgress,
    /// The linked agent task succeeded, or the user marked it done.
    Done,
}

/// How important an item is to the user. Normal is the default so every item
/// created before this field existed keeps a meaningful value.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkItemImportance {
    Low,
    #[default]
    Normal,
    High,
}

impl WorkItemImportance {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::Normal => "normal",
            Self::High => "high",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "low" => Some(Self::Low),
            "normal" => Some(Self::Normal),
            "high" => Some(Self::High),
            _ => None,
        }
    }
}

impl WorkItemStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::InProgress => "in_progress",
            Self::Done => "done",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "pending" => Some(Self::Pending),
            "in_progress" => Some(Self::InProgress),
            "done" => Some(Self::Done),
            _ => None,
        }
    }
}

impl WorkItem {
    pub fn new(
        id: String,
        project_id: String,
        title: &str,
        description: &str,
        importance: WorkItemImportance,
        now: &str,
    ) -> Result<Self, LocalError> {
        let title = required(title, LocalError::EmptyTitle)?;
        Ok(Self {
            id,
            project_id,
            title: title.to_owned(),
            description: description.trim().to_owned(),
            status: WorkItemStatus::Pending,
            importance,
            agent_task_id: None,
            created_at: now.to_owned(),
            updated_at: now.to_owned(),
        })
    }

    /// Replace only the fields the edit form actually submitted; a cleared
    /// description is meaningful and stays allowed.
    pub fn edit(
        &mut self,
        title: Option<&str>,
        description: Option<&str>,
        importance: Option<WorkItemImportance>,
        now: &str,
    ) -> Result<(), LocalError> {
        let title = match title {
            Some(title) => Some(required(title, LocalError::EmptyTitle)?),
            None => None,
        };
        if let Some(title) = title {
            self.title = title.to_owned();
        }
        if let Some(description) = description {
            self.description = description.trim().to_owned();
        }
        if let Some(importance) = importance {
            self.importance = importance;
        }
        self.updated_at = now.to_owned();
        Ok(())
    }

    pub fn set_status(&mut self, status: WorkItemStatus, now: &str) {
        self.status = status;
        self.updated_at = now.to_owned();
    }

    /// Marks the item done. Kept separate from [`Self::set_status`] so the
    /// auto-complete path reads as what it does.
    pub fn complete(&mut self, now: &str) {
        self.set_status(WorkItemStatus::Done, now);
    }

    /// Link an agent task and move the item to in progress: a linked task means
    /// work has started, so the board should not still say pending.
    pub fn attach_task(&mut self, task_id: &str, now: &str) -> Result<(), LocalError> {
        let task_id = required(task_id, LocalError::EmptyTaskId)?;
        self.agent_task_id = Some(task_id.to_owned());
        self.status = WorkItemStatus::InProgress;
        self.updated_at = now.to_owned();
        Ok(())
    }

    /// Drop the link to the agent task but keep the status: the status is the
    /// user's own field, so unlinking must not quietly move the item back to
    /// pending and hide that they had started it.
    pub fn clear_task(&mut self, now: &str) {
        self.agent_task_id = None;
        self.updated_at = now.to_owned();
    }
}

fn required(value: &str, error: LocalError) -> Result<&str, LocalError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        Err(error)
    } else {
        Ok(trimmed)
    }
}
