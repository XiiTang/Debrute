use crate::model_request::{common::ExecutionContext, types::ModelRequestError};

use super::{ImageResult, gemini_interactions_image};

pub(super) fn execute(
    context: &mut ExecutionContext<'_>,
) -> Result<ImageResult, ModelRequestError> {
    gemini_interactions_image::execute(context, "gemini-3-pro-image")
}
