// Invoked with a trusted, locally generated `data` value by layer_export.rs.
(function () {
    var previousInteraction = app.userInteractionLevel;
    var previousDocument = app.documents.length ? app.activeDocument : null;
    var document = null;
    var warnings = [];
    function fontFor(text) {
        var fallback = null;
        for (var i = 0; i < app.textFonts.length; i++) {
            var font = app.textFonts[i];
            if (font.name === text.fontFamily) return font;
            if (font.family === text.fontFamily) {
                if (!fallback) fallback = font;
                if (/bold|heavy|black|粗/i.test(font.style) === text.bold) return font;
            }
        }
        if (fallback) return fallback;
        warnings.push("字体未匹配，请在 Illustrator 中检查：" + text.fontFamily);
        return app.textFonts.getByName("ArialMT");
    }
    try {
        app.userInteractionLevel = UserInteractionLevel.DONTDISPLAYALERTS;
        document = app.documents.add(DocumentColorSpace.RGB, data.width, data.height);
        var emptyLayer = document.layers[0];
        for (var i = 0; i < data.layers.length; i++) {
            var source = data.layers[i];
            var layer = document.layers.add();
            layer.name = source.name;
            if (source.text) {
                var text = source.text;
                var path = layer.pathItems.rectangle(data.height - source.y, source.x, source.width, source.height);
                path.stroked = false; path.filled = false;
                var frame = document.textFrames.areaText(path);
                frame.contents = text.content.replace(/\n/g, "\r");
                var attributes = frame.textRange.characterAttributes;
                attributes.textFont = fontFor(text);
                attributes.size = text.fontSize * source.height / text.boxHeight;
                attributes.horizontalScale = (source.width / text.boxWidth) / (source.height / text.boxHeight) * 100;
                attributes.autoLeading = false;
                attributes.leading = attributes.size * text.lineHeight;
                attributes.tracking = text.letterSpacing / text.fontSize * 1000;
                var color = new RGBColor();
                color.red = parseInt(text.color.substr(1, 2), 16);
                color.green = parseInt(text.color.substr(3, 2), 16);
                color.blue = parseInt(text.color.substr(5, 2), 16);
                attributes.fillColor = color;
                frame.textRange.paragraphAttributes.justification = text.align === "center" ? Justification.CENTER : text.align === "right" ? Justification.RIGHT : Justification.LEFT;
                frame.textRange.paragraphAttributes.hyphenation = false;
            } else {
                var item = layer.placedItems.add();
                item.file = new File(source.file);
                item.width = source.width; item.height = source.height;
                item.position = [source.x, data.height - source.y];
                item.embed();
            }
            layer.opacity = source.opacity * 100;
            layer.visible = source.visible;
        }
        emptyLayer.remove();
        var options = new IllustratorSaveOptions();
        options.pdfCompatible = true;
        options.compressed = true;
        options.embedLinkedFiles = true;
        document.saveAs(new File(data.output), options);
        return "BOWERBIRD_AI_OK\n" + warnings.join("\n");
    } finally {
        if (document) document.close(SaveOptions.DONOTSAVECHANGES);
        if (previousDocument) previousDocument.activate();
        app.userInteractionLevel = previousInteraction;
    }
}());
