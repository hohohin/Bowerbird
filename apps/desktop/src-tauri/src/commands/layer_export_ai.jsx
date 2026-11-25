// Invoked with a trusted, locally generated `data` value by layer_export.rs.
(function () {
    var previousInteraction = app.userInteractionLevel;
    var previousDocument = app.documents.length ? app.activeDocument : null;
    var document = null;
    var warnings = [];
    var fonts = {};
    function warn(message) {
        for (var i = 0; i < warnings.length; i++) if (warnings[i] === message) return;
        warnings.push(message);
    }
    function fontFor(text) {
        var key = "font:" + text.fontFamily + ":" + !!text.bold + ":" + !!text.italic;
        if (fonts[key]) return fonts[key];
        var fallback = null, best = -1;
        for (var i = 0; i < app.textFonts.length; i++) {
            var font = app.textFonts[i];
            if (font.name !== text.fontFamily && font.family !== text.fontFamily) continue;
            var score = (/bold|heavy|black|粗/i.test(font.style) === !!text.bold ? 2 : 0)
                + (/italic|oblique|斜/i.test(font.style) === !!text.italic ? 1 : 0);
            if (score === 3) return fonts[key] = font;
            if (score > best) { fallback = font; best = score; }
        }
        if (fallback) {
            warn("未匹配所需的字体样式，请在 Illustrator 中检查：" + text.fontFamily);
            return fonts[key] = fallback;
        }
        warn("字体未匹配，请在 Illustrator 中检查：" + text.fontFamily);
        return fonts[key] = app.textFonts.getByName("ArialMT");
    }
    function applyStyle(attributes, text) {
        attributes.textFont = fontFor(text);
        attributes.underline = !!text.underline;
        attributes.strikeThrough = !!text.strikethrough;
        var color = new RGBColor();
        color.red = parseInt(text.color.substr(1, 2), 16);
        color.green = parseInt(text.color.substr(3, 2), 16);
        color.blue = parseInt(text.color.substr(5, 2), 16);
        attributes.fillColor = color;
    }
    function runStyle(text, run) {
        var style = {};
        var keys = ["fontFamily", "color", "bold", "italic", "underline", "strikethrough", "shadow"];
        for (var i = 0; i < keys.length; i++) {
            var key = keys[i];
            style[key] = run[key] === undefined ? text[key] : run[key];
        }
        return style;
    }
    function applyRuns(frame, text, fontSize, name) {
        var runs = text.runs || [];
        var hasShadow = !!text.shadow && /\S/.test(text.content), hasPlain = !text.shadow && /\S/.test(text.content);
        if (runs.length) {
            var characters = frame.textRange.characters;
            var offset = 0, index = 0;
            hasShadow = false; hasPlain = false;
            for (var i = 0; i < characters.length; i++) {
                var character = characters[i];
                while (index < runs.length && runs[index].end <= offset) index++;
                var run = runs[index];
                var style = run && run.start <= offset ? runStyle(text, run) : text;
                if (style !== text) applyStyle(character.characterAttributes, style);
                if (/\S/.test(character.contents)) {
                    if (style.shadow) hasShadow = true;
                    else hasPlain = true;
                }
                offset += character.contents.length;
            }
        }
        if (!hasShadow) return;
        if (hasPlain) {
            warn("此文字层含部分文字阴影，请在 Illustrator 中调整：" + name);
            return;
        }
        try {
            frame.applyEffect('<LiveEffect name="Adobe Drop Shadow"><Dict data="R horz 0 I blnd 1 R opac 0.4 R dark 100 B pair 1 I csrc 0 R vert '
                + (fontSize * .08) + ' R blur ' + (fontSize * .1) + ' B usePSLBlur 1 I Adobe Effect Expand Before Version 16 " /></LiveEffect>');
        } catch (error) {
            warn("未能应用文字阴影，请在 Illustrator 中调整：" + name);
        }
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
                applyStyle(attributes, text);
                attributes.size = text.fontSize * source.height / text.boxHeight;
                attributes.horizontalScale = (source.width / text.boxWidth) / (source.height / text.boxHeight) * 100;
                attributes.autoLeading = false;
                attributes.leading = attributes.size * text.lineHeight;
                attributes.tracking = text.letterSpacing / text.fontSize * 1000;
                applyRuns(frame, text, attributes.size, source.name);
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
