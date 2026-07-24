use super::{
    audio,
    common::ExecutionContext,
    types::{GenerationError, ModelExecution},
};

pub(super) fn execute(context: ExecutionContext<'_>) -> Result<ModelExecution, GenerationError> {
    audio::execute(context)
}
