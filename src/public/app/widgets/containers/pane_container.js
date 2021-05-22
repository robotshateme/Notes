import FlexContainer from "./flex_container.js";
import appContext from "../../services/app_context.js";

export default class PaneContainer extends FlexContainer {
    constructor(widgetFactory) {
        super('row');

        this.widgetFactory = widgetFactory;
        this.widgets = {};

        this.class('pane-container-widget');
        this.css('flex-grow', '1');
    }

    async newNoteContextCreatedEvent({noteContext}) {
        const widget = this.widgetFactory();

        const $renderedWidget = widget.render();

        $renderedWidget.attr("data-tab-id", noteContext.ntxId);

        $renderedWidget.on('click', () => appContext.tabManager.activateNoteContext(noteContext.ntxId));

        this.$widget.append($renderedWidget);

        widget.toggleExt(false);

        this.widgets[noteContext.ntxId] = widget;

        await widget.handleEvent('setNoteContext', { noteContext });

        this.child(widget);
    }

    async openNewPaneCommand() {
        const noteContext = await appContext.tabManager.openEmptyTab(null, 'root', appContext.tabManager.getActiveContext().ntxId);

        await appContext.tabManager.activateNoteContext(noteContext.ntxId);

        await noteContext.setEmpty();
    }

    activeContextChangedEvent() {
        this.refresh();
    }

    noteSwitchedAndActivatedEvent() {
        this.refresh();
    }

    async refresh() {
        this.toggleExt(true);
    }

    toggleInt(show) {} // not needed

    toggleExt(show) {
        const activeMainContext = appContext.tabManager.getActiveMainContext();
        const activeNtxId = activeMainContext ? activeMainContext.ntxId : null;

        for (const ntxId in this.widgets) {
            const noteContext = appContext.tabManager.getNoteContextById(ntxId);

            const widget = this.widgets[ntxId];
            widget.toggleExt(show && activeNtxId && [noteContext.ntxId, noteContext.mainNtxId].includes(activeNtxId));
        }
    }

    /**
     * widget.hasBeenAlreadyShown is intended for lazy loading of cached tabs - initial note switches of new tabs
     * are not executed, we're waiting for the first tab activation and then we update the tab. After this initial
     * activation further note switches are always propagated to the tabs.
     */
    handleEventInChildren(name, data) {
        if (['noteSwitched', 'noteSwitchedAndActivated'].includes(name)) {
            // this event is propagated only to the widgets of a particular tab
            const widget = this.widgets[data.noteContext.ntxId];

            if (!widget) {
                return Promise.resolve();
            }

            if (widget.hasBeenAlreadyShown
                || name === 'noteSwitchedAndActivated'
                || appContext.tabManager.getActiveMainContext() === data.noteContext.getMainContext()
            ) {
                widget.hasBeenAlreadyShown = true;

                return [
                    widget.handleEvent('noteSwitched', data),
                    this.refreshNotShown(data)
                ];
            }
            else {
                return Promise.resolve();
            }
        }

        if (name === 'activeContextChanged') {
            return this.refreshNotShown(data);
        } else {
            return super.handleEventInChildren(name, data);
        }
    }

    refreshNotShown(data) {
        const promises = [];

        for (const subContext of data.noteContext.getMainContext().getSubContexts()) {
            const widget = this.widgets[subContext.ntxId];

            if (!widget.hasBeenAlreadyShown) {
                widget.hasBeenAlreadyShown = true;

                promises.push(widget.handleEvent('activeContextChanged', {noteContext: subContext}));
            }
        }

        return Promise.all(promises);
    }
}