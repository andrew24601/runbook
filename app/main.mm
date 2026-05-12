#include <iostream>
#include <string>

#include "window.hpp"

int main(int argc, char** argv) {
    std::string workbookPath;
    if (argc > 1 && argv[1] != nullptr) {
        workbookPath = argv[1];
    }

    std::string errorMessage;
    if (doofbook_app::runApplication(workbookPath, &errorMessage)) {
        return 0;
    }

    if (!errorMessage.empty()) {
        std::cerr << errorMessage << '\n';
    }

    return 1;
}