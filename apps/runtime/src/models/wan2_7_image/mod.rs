use super::{ModelDefinition, bind};

mod executor;

#[cfg(test)]
mod contract_tests;

pub(super) fn registration() -> ModelDefinition {
    bind(
        include_str!("definition.json"),
        include_str!("manual.md"),
        executor::execute,
    )
}
