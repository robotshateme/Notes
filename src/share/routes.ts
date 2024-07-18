import safeCompare = require('safe-compare');
import ejs = require('ejs');

import type { Request, Response, Router } from "express";

import shaca = require('./shaca/shaca');
import shacaLoader = require('./shaca/shaca_loader');
import shareRoot = require('./share_root');
import contentRenderer = require('./content_renderer');
import assetPath = require('../services/asset_path');
import appPath = require('../services/app_path');
import searchService = require('../services/search/services/search');
import SearchContext = require('../services/search/search_context');
import log = require('../services/log');
import SNote = require('./shaca/entities/snote');
import SBranch = require('./shaca/entities/sbranch');
import SAttachment = require('./shaca/entities/sattachment');

function getSharedSubTreeRoot(note: SNote): { note?: SNote; branch?: SBranch } {
    if (note.noteId === shareRoot.SHARE_ROOT_NOTE_ID) {
        // share root itself is not shared
        return {};
    }

    // every path leads to share root, but which one to choose?
    // for the sake of simplicity, URLs are not note paths
    const parentBranch = note.getParentBranches()[0];

    if (parentBranch.parentNoteId === shareRoot.SHARE_ROOT_NOTE_ID) {
        return {
            note,
            branch: parentBranch
        };
    }

    return getSharedSubTreeRoot(parentBranch.getParentNote());
}

function addNoIndexHeader(note: SNote, res: Response) {
    if (note.isLabelTruthy('shareDisallowRobotIndexing')) {
        res.setHeader('X-Robots-Tag', 'noindex');
    }
}

function requestCredentials(res: Response) {
    res.setHeader('WWW-Authenticate', 'Basic realm="User Visible Realm", charset="UTF-8"')
        .sendStatus(401);
}

function checkAttachmentAccess(attachmentId: string, req: Request, res: Response) {
    const attachment = shaca.getAttachment(attachmentId);

    if (!attachment) {
        res.status(404)
            .json({ message: `Attachment '${attachmentId}' not found.` });

        return false;
    }

    const note = checkNoteAccess(attachment.ownerId, req, res);

    // truthy note means the user has access, and we can return the attachment
    return note ? attachment : false;
}

function checkNoteAccess(noteId: string, req: Request, res: Response) {
    const note = shaca.getNote(noteId);

    if (!note) {
        res.status(404)
            .json({ message: `Note '${noteId}' not found.` });

        return false;
    }

    if (noteId === '_share' && !shaca.shareIndexEnabled) {
        res.status(403)
            .json({ message: `Accessing share index is forbidden.` });

        return false;
    }

    const credentials = note.getCredentials();

    if (credentials.length === 0) {
        return note;
    }

    const header = req.header("Authorization");

    if (!header?.startsWith("Basic ")) {
        requestCredentials(res);
        return false;
    }

    const base64Str = header.substring("Basic ".length);
    const buffer = Buffer.from(base64Str, 'base64');
    const authString = buffer.toString('utf-8');

    for (const credentialLabel of credentials) {
        if (safeCompare(authString, credentialLabel.value)) {
            return note; // success;
        }
    }

    return false;
}

function renderImageAttachment(image: SNote, res: Response, attachmentName: string) {
    let svgString = '<svg/>'
    const attachment = image.getAttachmentByTitle(attachmentName);
    if (!attachment) {
        res.status(404).render("share/404");
        return;
    }
    const content = attachment.getContent();
    if (typeof content === "string") {
        svgString = content;
    } else {
        // backwards compatibility, before attachments, the SVG was stored in the main note content as a separate key
        const contentSvg = image.getJsonContentSafely()?.svg;

        if (contentSvg) {
            svgString = contentSvg;
        }
    }

    const svg = svgString
    res.set('Content-Type', "image/svg+xml");
    res.set("Cache-Control", "no-cache, no-store, must-revalidate");
    res.send(svg);
}

function register(router: Router) {
    function renderNote(note: SNote, req: Request, res: Response) {
        if (!note) {
            res.status(404).render("share/404");
            return;
        }

        if (!checkNoteAccess(note.noteId, req, res)) {
            requestCredentials(res);

            return;
        }

        addNoIndexHeader(note, res);

        if (note.isLabelTruthy('shareRaw')) {
            res.setHeader('Content-Type', note.mime)
                .send(note.getContent());

            return;
        }

        const { header, content, isEmpty } = contentRenderer.getContent(note);
        const subRoot = getSharedSubTreeRoot(note);
        const opts = { note, header, content, isEmpty, subRoot, assetPath, appPath };
        let useDefaultView = true;

        // Check if the user has their own template
        if (note.hasRelation('shareTemplate')) {
            // Get the template note and content
            const templateId = note.getRelation('shareTemplate')?.value;
            const templateNote = templateId && shaca.getNote(templateId);

            // Make sure the note type is correct
            if (templateNote && templateNote.type === 'code' && templateNote.mime === 'application/x-ejs') {

                // EJS caches the result of this so we don't need to pre-cache
                const includer = (path: string) => {
                    const childNote = templateNote.children.find(n => path === n.title);
                    if (!childNote) throw new Error("Unable to find child note.");
                    if (childNote.type !== 'code' || childNote.mime !== 'application/x-ejs') throw new Error("Incorrect child note type.");

                    const template = childNote.getContent();
                    if (typeof template !== "string") throw new Error("Invalid template content type.");

                    return { template };
                };

                // Try to render user's template, w/ fallback to default view
                try {
                    const content = templateNote.getContent();
                    if (typeof content === "string") {
                        const ejsResult = ejs.render(content, opts, { includer });
                        res.send(ejsResult);
                        useDefaultView = false; // Rendering went okay, don't use default view
                    }
                }
                catch (e: any) {
                    log.error(`Rendering user provided share template (${templateId}) threw exception ${e.message} with stacktrace: ${e.stack}`);
                }
            }
        }

        if (useDefaultView) {
            res.render('share/page', opts);
        }
    }

    router.get('/share/', (req, res, next) => {
        if (req.path.substr(-1) !== '/') {
            res.redirect('../share/');
            return;
        }

        shacaLoader.ensureLoad();

        if (!shaca.shareRootNote) {
            return res.status(404)
                .json({ message: "Share root note not found" });
        }

        renderNote(shaca.shareRootNote, req, res);
    });

    router.get('/share/:shareId', (req, res, next) => {
        shacaLoader.ensureLoad();

        const { shareId } = req.params;

        const note = shaca.aliasToNote[shareId] || shaca.notes[shareId];

        renderNote(note, req, res);
    });

    router.get('/share/api/notes/:noteId', (req, res, next) => {
        shacaLoader.ensureLoad();
        let note: SNote | boolean;

        if (!(note = checkNoteAccess(req.params.noteId, req, res))) {
            return;
        }

        addNoIndexHeader(note, res);

        res.json(note.getPojo());
    });

    router.get('/share/api/notes/:noteId/download', (req, res, next) => {
        shacaLoader.ensureLoad();

        let note: SNote | boolean;

        if (!(note = checkNoteAccess(req.params.noteId, req, res))) {
            return;
        }

        addNoIndexHeader(note, res);

        const utils = require('../services/utils');

        const filename = utils.formatDownloadTitle(note.title, note.type, note.mime);

        res.setHeader('Content-Disposition', utils.getContentDisposition(filename));

        res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
        res.setHeader('Content-Type', note.mime);

        res.send(note.getContent());
    });

    // :filename is not used by trilium, but instead used for "save as" to assign a human-readable filename
    router.get('/share/api/images/:noteId/:filename', (req, res, next) => {
        shacaLoader.ensureLoad();

        let image: SNote | boolean;

        if (!(image = checkNoteAccess(req.params.noteId, req, res))) {
            return;
        }

        if (image.type === 'image') {
            // normal image
            res.set('Content-Type', image.mime);
            addNoIndexHeader(image, res);
            res.send(image.getContent());
        } else if (image.type === "canvas") {
            renderImageAttachment(image, res, 'canvas-export.svg');
        } else if (image.type === 'mermaid') {
            renderImageAttachment(image, res, 'mermaid-export.svg');
        } else {
            return res.status(400)
                .json({ message: "Requested note is not a shareable image" });
        }
    });

    // :filename is not used by trilium, but instead used for "save as" to assign a human-readable filename
    router.get('/share/api/attachments/:attachmentId/image/:filename', (req, res, next) => {
        shacaLoader.ensureLoad();

        let attachment: SAttachment | boolean;

        if (!(attachment = checkAttachmentAccess(req.params.attachmentId, req, res))) {
            return;
        }

        if (attachment.role === "image") {
            res.set('Content-Type', attachment.mime);
            addNoIndexHeader(attachment.note, res);
            res.send(attachment.getContent());
        } else {
            return res.status(400)
                .json({ message: "Requested attachment is not a shareable image" });
        }
    });

    router.get('/share/api/attachments/:attachmentId/download', (req, res, next) => {
        shacaLoader.ensureLoad();

        let attachment: SAttachment | boolean;

        if (!(attachment = checkAttachmentAccess(req.params.attachmentId, req, res))) {
            return;
        }

        addNoIndexHeader(attachment.note, res);

        const utils = require('../services/utils');

        const filename = utils.formatDownloadTitle(attachment.title, null, attachment.mime);

        res.setHeader('Content-Disposition', utils.getContentDisposition(filename));

        res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
        res.setHeader('Content-Type', attachment.mime);

        res.send(attachment.getContent());
    });

    // used for PDF viewing
    router.get('/share/api/notes/:noteId/view', (req, res, next) => {
        shacaLoader.ensureLoad();

        let note: SNote | boolean;

        if (!(note = checkNoteAccess(req.params.noteId, req, res))) {
            return;
        }

        addNoIndexHeader(note, res);

        res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
        res.setHeader('Content-Type', note.mime);

        res.send(note.getContent());
    });

    // Used for searching, require noteId so we know the subTreeRoot
    router.get('/share/api/notes', (req, res, next) => {
        shacaLoader.ensureLoad();

        const ancestorNoteId = req.query.ancestorNoteId ?? "_share";
        let note;

        if (typeof ancestorNoteId !== "string") {
            return res.status(400).json({ message: "'ancestorNoteId' parameter is mandatory." });
        }

        // This will automatically return if no ancestorNoteId is provided and there is no shareIndex
        if (!(note = checkNoteAccess(ancestorNoteId, req, res))) {
            return;
        }

        const { search } = req.query;

        if (typeof search !== "string" || !search?.trim()) {
            return res.status(400).json({ message: "'search' parameter is mandatory." });
        }

        const searchContext = new SearchContext({ ancestorNoteId: ancestorNoteId });
        const searchResults = searchService.findResultsWithQuery(search, searchContext);
        const filteredResults = searchResults.map(sr => {
            const fullNote = shaca.notes[sr.noteId];
            const startIndex = sr.notePathArray.indexOf(ancestorNoteId);
            const localPathArray = sr.notePathArray.slice(startIndex + 1).filter(id => shaca.notes[id]);
            const pathTitle = localPathArray.map(id => shaca.notes[id].title).join(" / ");
            return { id: fullNote.shareId, title: fullNote.title, score: sr.score, path: pathTitle };
        });

        res.json({ results: filteredResults });
    });
}

export = {
    register
}
