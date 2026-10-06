// Development-only Keychain bridge. Keep this executable unchanged when the app
// rebuilds: self-signed code is partitioned by CDHash, not its certificate.
#include <Security/Security.h>
#include <CommonCrypto/CommonDigest.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

#ifndef KEYCHAIN_SERVICE
#define KEYCHAIN_SERVICE "com.bowerbird.desktop"
#endif
static const char *account = "supabase-refresh-token";

// Only a live Bowerbird parent signed by our own certificate may use the bridge.
static OSStatus validate_parent(void) {
    SecCodeRef self = NULL, parent = NULL;
    CFDictionaryRef info = NULL;
    SecRequirementRef requirement = NULL;
    OSStatus status = SecCodeCopySelf(kSecCSDefaultFlags, &self);
    if (!status) status = SecCodeCopySigningInformation(self, kSecCSSigningInformation, &info);
    if (!status) {
        CFArrayRef certificates = CFDictionaryGetValue(info, kSecCodeInfoCertificates);
        if (!certificates || !CFArrayGetCount(certificates)) status = errSecAuthFailed;
        else {
            CFDataRef certificate = SecCertificateCopyData((SecCertificateRef)CFArrayGetValueAtIndex(certificates, 0));
            unsigned char digest[CC_SHA1_DIGEST_LENGTH];
            CC_SHA1(CFDataGetBytePtr(certificate), (CC_LONG)CFDataGetLength(certificate), digest);
            CFRelease(certificate);
            char hash[CC_SHA1_DIGEST_LENGTH * 2 + 1];
            for (int i = 0; i < CC_SHA1_DIGEST_LENGTH; i++) sprintf(hash + i * 2, "%02x", digest[i]);
            CFStringRef rule = CFStringCreateWithFormat(NULL, NULL,
                CFSTR("identifier \"com.bowerbird.desktop\" and certificate leaf = H\"%s\""), hash);
            status = SecRequirementCreateWithString(rule, kSecCSDefaultFlags, &requirement);
            CFRelease(rule);
        }
    }
    pid_t pid = getppid();
    CFNumberRef number = CFNumberCreate(NULL, kCFNumberIntType, &pid);
    const void *key = kSecGuestAttributePid, *value = number;
    CFDictionaryRef attributes = CFDictionaryCreate(NULL, &key, &value, 1,
        &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    if (!status) status = SecCodeCopyGuestWithAttributes(NULL, attributes, kSecCSDefaultFlags, &parent);
    if (!status) status = SecCodeCheckValidity(parent, kSecCSDefaultFlags, requirement);
    if (!status && pid != getppid()) status = errSecAuthFailed;
    CFRelease(attributes);
    CFRelease(number);
    if (requirement) CFRelease(requirement);
    if (info) CFRelease(info);
    if (self) CFRelease(self);
    if (parent) CFRelease(parent);
    return status;
}

int main(int argc, char **argv) {
    if (argc < 2 || argc > 3 || (argc == 3 && strcmp(argv[2], "--no-ui"))) return 2;
    const int read = !strcmp(argv[1], "get");
    const int write = !strcmp(argv[1], "set");
    const int remove = !strcmp(argv[1], "delete");
    if (!read && !write && !remove) return 2;
    OSStatus status = validate_parent();
    if (status) { fprintf(stderr, "Keychain caller rejected (%d)\n", (int)status); return 4; }
    if (argc == 3) SecKeychainSetUserInteractionAllowed(false);
#ifdef KEYCHAIN_TEST_NO_UI
    SecKeychainSetUserInteractionAllowed(false);
#endif

    // Match keyring's User domain. Never accept a service/account from the caller.
    SecKeychainRef keychain = NULL;
    status = SecKeychainCopyDomainDefault(kSecPreferencesDomainUser, &keychain);
    if (status) { fprintf(stderr, "Keychain unavailable (%d)\n", (int)status); return 1; }
    SecKeychainItemRef item = NULL;
    UInt32 length = 0;
    void *data = NULL;
    status = SecKeychainFindGenericPassword(keychain, (UInt32)strlen(KEYCHAIN_SERVICE), KEYCHAIN_SERVICE,
        (UInt32)strlen(account), account, read ? &length : NULL, read ? &data : NULL, &item);
    if (read && !status) {
        if (fwrite(data, 1, length, stdout) != length) status = errSecIO;
        SecKeychainItemFreeContent(NULL, data);
    } else if (write && (!status || status == errSecItemNotFound)) {
        unsigned char secret[16384];
        size_t size = fread(secret, 1, sizeof(secret), stdin);
        if (ferror(stdin) || size == 0 || size == sizeof(secret)) status = errSecParam;
        else if (item) status = SecKeychainItemModifyAttributesAndData(item, NULL, (UInt32)size, secret);
        else status = SecKeychainAddGenericPassword(keychain, (UInt32)strlen(KEYCHAIN_SERVICE), KEYCHAIN_SERVICE,
            (UInt32)strlen(account), account, (UInt32)size, secret, NULL);
        volatile unsigned char *clear = secret;
        for (size_t i = 0; i < sizeof(secret); i++) clear[i] = 0;
    } else if (remove && !status) status = SecKeychainItemDelete(item);
    if (item) CFRelease(item);
    CFRelease(keychain);
    if (status == errSecItemNotFound) return 3;
    if (status) fprintf(stderr, "Keychain operation failed (%d)\n", (int)status);
    return status ? 1 : 0;
}
