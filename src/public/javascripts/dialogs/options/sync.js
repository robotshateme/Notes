import server from "../../services/server.js";
import toastService from "../../services/toast.js";

const TPL = `
<h4 style="margin-top: 0px;">Sync configuration</h4>

<form id="sync-setup-form">
    <div class="form-group">
        <label for="sync-server-host">Server instance address</label>
        <input class="form-control" id="sync-server-host" placeholder="https://<host>:<port>">
    </div>

    <div class="form-group">
        <label for="sync-server-timeout">Sync timeout (milliseconds)</label>
        <input class="form-control" id="sync-server-timeout" min="1" max="10000000" type="number">
    </div>

    <div class="form-group">
        <label for="sync-proxy">Sync proxy server (optional)</label>
        <input class="form-control" id="sync-proxy" placeholder="https://<host>:<port>">

        <p><strong>Note:</strong> If you leave proxy setting blank, system proxy will be used (applies to desktop/electron build only)</p>
    </div>

    <div style="display: flex; justify-content: space-between;">
        <button class="btn btn-primary">Save</button>

        <button class="btn btn-secondary" type="button" data-help-page="Synchronization">Help</button>
    </div>
</form>

<br/>

<h4>Sync test</h4>

<p>This will test connection and handshake to the sync server. If sync server isn't initialized, this will set it up to sync with local document.</p>

<button id="test-sync-button" class="btn btn-secondary">Test sync</button>`;

export default class SyncOptions {
    constructor() {
        $("#options-sync-setup").html(TPL);

        this.$form = $("#sync-setup-form");
        this.$syncServerHost = $("#sync-server-host");
        this.$syncServerTimeout = $("#sync-server-timeout");
        this.$syncProxy = $("#sync-proxy");
        this.$testSyncButton = $("#test-sync-button");

        this.$form.submit(() => this.save());

        this.$testSyncButton.click(async () => {
            const result = await server.post('sync/test');

            if (result.success) {
                toastService.showMessage(result.message);
            }
            else {
                toastService.showError("Sync server handshake failed, error: " + result.message);
            }
        });
    }

    optionsLoaded(options) {
        this.$syncServerHost.val(options['syncServerHost']);
        this.$syncServerTimeout.val(options['syncServerTimeout']);
        this.$syncProxy.val(options['syncProxy']);
    }

    save() {
        const opts = {
            'syncServerHost': this.$syncServerHost.val(),
            'syncServerTimeout': this.$syncServerTimeout.val(),
            'syncProxy': this.$syncProxy.val()
        };

        server.put('options', opts).then(()  => toastService.showMessage("Options change have been saved."));

        return false;
    }
}