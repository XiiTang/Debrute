use std::collections::BTreeSet;

use debrute_runtime::models::ModelCatalog;

#[test]
fn bundled_exact_models_are_complete_and_unique() {
    let catalog = ModelCatalog::bundled();
    let definitions = catalog.all();

    assert!(!definitions.is_empty());
    assert_eq!(
        definitions
            .iter()
            .map(|definition| definition.id())
            .collect::<BTreeSet<_>>()
            .len(),
        definitions.len(),
    );
    for definition in definitions {
        assert!(!definition.id().trim().is_empty());
        assert!(!definition.summary().trim().is_empty());
        assert!(!definition.default_base_url().trim().is_empty());
        assert!(!definition.default_request_model_id().trim().is_empty());
        assert!(definition.arguments_schema().is_object());
        assert!(definition.manual().contains(definition.id()));
    }
}
