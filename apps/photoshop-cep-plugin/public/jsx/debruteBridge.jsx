var debruteBridge = (function () {
  function ok(value) {
    return JSON.stringify({ ok: true, value: value });
  }

  function fail(error) {
    return JSON.stringify({
      ok: false,
      message: error && error.message ? error.message : String(error)
    });
  }

  function run(callback) {
    try {
      return ok(callback());
    } catch (error) {
      return fail(error);
    }
  }

  function activeDocumentOrThrow() {
    if (!app.documents.length) {
      throw new Error('No active Photoshop document.');
    }
    return app.activeDocument;
  }

  function hostVersion() {
    return run(function () {
      return app.version;
    });
  }

  function currentSelectionSnapshot() {
    return run(function () {
      if (!app.documents.length) {
        return { documentTitle: null, documentCount: 0, selectedItems: [] };
      }
      var document = app.activeDocument;
      var selectedIds = selectedLayerIds();
      var selectedItems = [];
      for (var index = 0; index < document.layers.length; index += 1) {
        var layer = document.layers[index];
        if (selectedIds[layer.id]) {
          selectedItems.push({
            layerId: layer.id,
            name: layer.name,
            kind: layer.typename === 'LayerSet' ? 'group' : 'layer'
          });
        }
      }
      return {
        documentTitle: document.name,
        documentCount: app.documents.length,
        selectedItems: selectedItems
      };
    });
  }

  function exportSelectedTopLevelPngs() {
    return run(function () {
      var document = activeDocumentOrThrow();
      var selectedIds = selectedLayerIds();
      var exports = [];
      for (var index = 0; index < document.layers.length; index += 1) {
        var layer = document.layers[index];
        if (selectedIds[layer.id]) {
          exports.push(exportLayerPng(document, layer));
        }
      }
      return exports;
    });
  }

  function temporaryImportPath(fileName) {
    return run(function () {
      return new File(Folder.temp.fsName + '/' + safeFileName(fileName)).fsName;
    });
  }

  function placeFileAsSmartObject(filePath) {
    return run(function () {
      activeDocumentOrThrow();
      var descriptor = new ActionDescriptor();
      descriptor.putPath(charIDToTypeID('null'), new File(filePath));
      executeAction(charIDToTypeID('Plc '), descriptor, DialogModes.NO);
      return true;
    });
  }

  function selectedLayerIds() {
    var ids = {};
    var reference = new ActionReference();
    reference.putProperty(charIDToTypeID('Prpr'), stringIDToTypeID('targetLayersIDs'));
    reference.putEnumerated(charIDToTypeID('Dcmn'), charIDToTypeID('Ordn'), charIDToTypeID('Trgt'));
    var descriptor = executeActionGet(reference);
    if (!descriptor.hasKey(stringIDToTypeID('targetLayersIDs'))) {
      ids[app.activeDocument.activeLayer.id] = true;
      return ids;
    }
    var list = descriptor.getList(stringIDToTypeID('targetLayersIDs'));
    for (var index = 0; index < list.count; index += 1) {
      ids[list.getReference(index).getIdentifier()] = true;
    }
    return ids;
  }

  function exportLayerPng(sourceDocument, layer) {
    var tempDocument = app.documents.add(
      sourceDocument.width,
      sourceDocument.height,
      sourceDocument.resolution,
      'Debrute Export',
      NewDocumentMode.RGB,
      DocumentFill.TRANSPARENT
    );
    app.activeDocument = sourceDocument;
    layer.duplicate(tempDocument, ElementPlacement.PLACEATBEGINNING);
    app.activeDocument = tempDocument;
    tempDocument.trim(TrimType.TRANSPARENT, true, true, true, true);
    var file = new File(Folder.temp.fsName + '/' + safeFileName(layer.name) + '-' + layer.id + '.png');
    var options = new PNGSaveOptions();
    tempDocument.saveAs(file, options, true, Extension.LOWERCASE);
    tempDocument.close(SaveOptions.DONOTSAVECHANGES);
    app.activeDocument = sourceDocument;
    return {
      suggestedName: layer.name,
      path: file.fsName
    };
  }

  function safeFileName(value) {
    return String(value || 'debrute-asset')
      .replace(/[\\/:*?"<>|]+/g, '-')
      .replace(/^\.+/, '')
      .substring(0, 80) || 'debrute-asset';
  }

  return {
    hostVersion: hostVersion,
    currentSelectionSnapshot: currentSelectionSnapshot,
    exportSelectedTopLevelPngs: exportSelectedTopLevelPngs,
    temporaryImportPath: temporaryImportPath,
    placeFileAsSmartObject: placeFileAsSmartObject
  };
}());
