export class ResourceManager
{
    constructor()
    {
        this.data = Resource.all;
        this.skippedImport = [];
        this.attributes = {};
        this.styleManager = new StyleManager(this);
        const styleMethods = Object.getOwnPropertyNames(StyleManager.prototype).filter(it => it !== "constructor");
        for (const key of styleMethods)
        {
            this[key] = function (...params)
            {
                this.styleManager[key](...params);
            };
        }
        this.setupColors();
    }
    setupColors()
    {
        this.color = new ColorProcessor(settings.customStyleColor);
        settings.foreground = this.color.foreground;
        settings.blueImageFilter = this.color.blueImageFilter;
        settings.pinkImageFilter = this.color.pinkImageFilter;
        settings.brightness = this.color.brightness;
        settings.filterInvert = this.color.filterInvert;

        const hexToRgba = input => this.color.rgbToString(this.color.hexToRgba(input));
        let styles = [];
        styles.push("--theme-color:" + settings.customStyleColor);
        for (let opacity = 10; opacity <= 90; opacity += 10)
        {
            const color = this.color.hexToRgba(settings.customStyleColor);
            color.a = opacity / 100;
            styles.push(`--theme-color-${opacity}:` + this.color.rgbToString(color));
        }
        styles.push("--foreground-color:" + settings.foreground);
        styles.push("--foreground-color-b:" + hexToRgba(settings.foreground + "b"));
        styles.push("--foreground-color-d:" + hexToRgba(settings.foreground + "d"));
        styles.push("--blue-image-filter:" + settings.blueImageFilter);
        styles.push("--pink-image-filter:" + settings.pinkImageFilter);
        styles.push("--brightness:" + settings.brightness);
        styles.push("--invert-filter:" + settings.filterInvert);
        styles.push("--blur-background-opacity:" + settings.blurBackgroundOpacity);
        styles.push("--custom-control-background-opacity:" + settings.customControlBackgroundOpacity);
        this.applyStyleFromText(`<style id="bilibili-evolved-variables">html{${styles.join(";")}}</style>`);
    }
    importAsync(componentName)
    {
        return new Promise(resolve =>
        {
            const resource = Resource.all[componentName];
            if (!resource)
            {
                this.skippedImport.push(componentName);
                resolve();
            }
            if (!resource.downloaded)
            {
                resource.download().then(() => resolve(this.import(componentName)));
            }
            else
            {
                resolve(this.import(componentName));
            }
        });
    }
    import(componentName)
    {
        const resource = Resource.all[componentName];
        if (!resource)
        {
            this.skippedImport.push(componentName);
            return;
        }
        if (resource.type.name === "html" || resource.type.name === "style")
        {
            if (!resource.downloaded)
            {
                console.error(`Import failed: component "${componentName}" is not loaded.`);
                return null;
            }
            return resource.text;
        }
        else
        {
            const asFileName = () =>
            {
                const keyword = componentName + ".min.js";
                for (const [name, value] of Object.entries(Resource.all))
                {
                    if (value.url.indexOf(keyword) !== -1)
                    {
                        return name;
                    }
                }
                return componentName;
            };
            const attribute = this.attributes[componentName] || this.attributes[asFileName()];
            if (attribute === undefined)
            {
                console.error(`Import failed: component "${componentName}" is not loaded.`);
                return null;
            }
            return attribute.export;
        }
    }
    async fetchByKey(key)
    {
        const resource = Resource.all[key];
        if (!resource)
        {
            return null;
        }
        const text = await resource.download().catch(reason =>
        {
            console.error(`Download error, XHR status: ${reason}`);
            let toastMessage = `无法下载组件<span>${Resource.all[key].displayName}</span>`;
            if (settings.toastInternalError)
            {
                toastMessage += "\n" + reason;
            }
            Toast.error(toastMessage, "错误");
        });
        await Promise.all(resource.dependencies
            .filter(it => it.type.name === "style")
            .map(it => this.styleManager.fetchStyleByKey(it.key)));
        await Promise.all(resource.dependencies
            .filter(it => it.type.name === "script")
            .map(it => this.fetchByKey(it.key)));
        this.applyComponent(key, text);
    }
    async fetch()
    {
        const isCacheValid = this.validateCache();
        let loadingToast = null;
        if (settings.toast === true)
        {
            await this.fetchByKey("toast");
            unsafeWindow.bilibiliEvolved.Toast = Toast = this.attributes.toast.export.Toast || this.attributes.toast.export;
            if (!isCacheValid && settings.useCache)
            {
                loadingToast = Toast.info(/*html*/`<div class="loading"></div>正在初始化脚本`, "初始化");
            }
        }
        const promises = [];
        for (const key in settings)
        {
            if (settings[key] === true && key !== "toast")
            {
                const promise = this.fetchByKey(key);
                if (promise)
                {
                    promises.push(promise);
                }
            }
        }
        await Promise.all(promises);
        saveSettings(settings);
        if (loadingToast)
        {
            loadingToast.dismiss();
        }
        await this.applyDropdownOptions();
        this.applyWidgets();
    }
    applyComponent(key, text)
    {
        const func = eval(text);
        if (func)
        {
            try
            {
                const attribute = func(settings, this) || {};
                this.attributes[key] = attribute;
            }
            catch (error)
            {
                console.error(`Failed to apply feature "${key}": ${error}`);
                let toastMessage = `加载组件<span>${Resource.all[key].displayName}</span>失败`;
                if (settings.toastInternalError)
                {
                    toastMessage += "\n" + error;
                }
                Toast.error(toastMessage, "错误");
            }
        }
    }
    async applyWidget(info)
    {
        let condition = true;
        if (typeof info.condition === "function")
        {
            condition = info.condition();
            if (condition instanceof Promise)
            {
                condition = await condition.catch(() => { return false; });
            }
        }
        if (condition === true)
        {
            if (info.content)
            {
                $(".widgets-container").append($(info.content));
            }
            if (info.success)
            {
                info.success();
            }
        }
    }
    async applyWidgets()
    {
        await Promise.all(Object.values(this.attributes)
            .filter(it => it.widget)
            .map(it => this.applyWidget(it.widget))
        );
    }
    async applyDropdownOptions()
    {
        async function applyDropdownOption(info)
        {
            if (Array.isArray(info))
            {
                await Promise.all(info.map(applyDropdownOption));
            }
            else
            {
                const dropdown = await SpinQuery.any(
                    () => $(`.gui-settings-dropdown:has(input[key=${info.key}])`));
                const list = dropdown.find("ul");
                const input = dropdown.find("input");
                info.items.forEach(item =>
                {
                    $(`<li>${item}</li>`).appendTo(list)
                        .on("click", () =>
                        {
                            input.val(item).trigger("input").change();
                        });
                });
            }
        }
        await Promise.all(Object.values(Resource.manifest)
            .filter(it => it.dropdown)
            .map(it => applyDropdownOption(it.dropdown))
        );
    }
    validateCache()
    {
        if (typeof offlineData !== "undefined") // offline version always has cache
        {
            return true;
        }
        if (Object.getOwnPropertyNames(settings.cache).length === 0) // has no cache
        {
            return false;
        }
        if (settings.cache.version === undefined) // Has newly downloaded cache
        {
            settings.cache.version = settings.currentVersion;
            saveSettings(settings);
            return true;
        }
        if (settings.cache.version !== settings.currentVersion) // Has old version cache
        {
            settings.cache = {};
            saveSettings(settings);
            return false;
        }
        return true; // Has cache
    }
}